/**
 * D3 — `createPeerServerHandler`: the request handler that answers the
 * MAP-over-JSON-RPC peer dialect on the server side, backed by an
 * `AgentAdapter` (for envoy-harness: the live `EnvoyHarnessAdapter`).
 *
 * - `peer/submit`   → `adapter.execute(ExecuteInput)` →
 *                     `PeerSubmitResponse` (`{ result, verdict? }`)
 * - `peer/verify`   → `adapter.verify(VerifyInput)` → `Verdict[]`
 * - `peer/manifest` → `adapter.buildManifest(BuildManifestInput)` → manifest
 * - `peer/ping`     → readiness + identity/model advertisement
 */

import type {
  RequestHandler,
} from "@envoymesh/envoy-harness";
import { VerifySessionBudget } from "@envoymesh/envoy-harness";
import type {
  AgentAdapter,
  BuildManifestInput,
  ExecuteInput,
  VerifyInput,
} from "@envoymesh/agent-adapter";
import type { CapabilityManifest } from "@envoymesh/protocol";

import { PeerContinuableTaskRegistry } from "./continuable-peer-tasks.js";
import { combinePeerVerdicts } from "./scoreboard.js";
import {
  PEER_CLOSE_METHOD,
  PEER_INTERRUPT_METHOD,
  PEER_MANIFEST_METHOD,
  PEER_PING_METHOD,
  PEER_SEND_METHOD,
  PEER_STATUS_METHOD,
  PEER_SUBMIT_CONTINUABLE_METHOD,
  PEER_SUBMIT_METHOD,
  PEER_VERIFY_METHOD,
  PEER_WAIT_SETTLE_METHOD,
  PEER_SCOREBOARD_LIST_METHOD,
  type PeerSubmitContinuableParams,
  type PeerSubmitResponse,
  type PeerTaskControlParams,
} from "./messages.js";
import { unwrapEnvelope, type PeerVerifier } from "./envelope.js";
import type { PeerEventSink } from "./events.js";
import type { PeerScoreboard } from "./scoreboard.js";

export interface PeerServerOptions {
  /** The MAP adapter that executes + verifies + advertises this peer. */
  adapter: AgentAdapter;
  /** Identity advertisement for `peer/ping`. */
  identity: { peerId: string; model?: string; ownerId?: string };
  /** D7 — when set, every request must carry a valid envelope signature. */
  verifier?: PeerVerifier;
  /** D7 — observability sink for request/response events. */
  onEvent?: PeerEventSink;
  /**
   * When true, every `peer/submit` runs `adapter.verify` after execute
   * and returns the combined verdict in the response (the honest-verdict
   * path). Enable only when the adapter's verify is cheap (rule-based) —
   * an LLM verifier doubles the cost per submit. When the verifier
   * throws, the submit still succeeds but the response carries no
   * verdict (the client falls back to its v1 placeholder).
   */
  verifyAfterExecute?: boolean;
  /**
   * Optional cap on how many verifications run per server/session
   * lifetime (R4.10 `maxVerificationsPerSession`). Applies to
   * `verifyAfterExecute` and `peer/verify`. Alias of the older
   * `maxVerifyAfterExecute` name.
   */
  maxVerificationsPerSession?: number;
  /**
   * @deprecated Prefer {@link maxVerificationsPerSession}.
   */
  maxVerifyAfterExecute?: number;
  /**
   * R4.10 — shared budget instance (host-owned session). When set,
   * overrides max* numeric options.
   */
  verifyBudget?: import("@envoymesh/envoy-harness").VerifySessionBudget;
  /** R4.9b — settled continuable-task retention (default 60s). `0` = immediate GC. */
  settledTaskTtlMs?: number;
  /** R4.11 — local scoreboard exposed via `peer/scoreboard/list`. */
  scoreboard?: PeerScoreboard;
}

/** Build a JSON-RPC request handler for the peer dialect. */
export function createPeerServerHandler(
  options: PeerServerOptions,
): RequestHandler {
  const { adapter, identity } = options;
  const max =
    options.maxVerificationsPerSession ?? options.maxVerifyAfterExecute;
  const verifyBudget =
    options.verifyBudget ??
    (max !== undefined
      ? new VerifySessionBudget({
          maxVerificationsPerSession: max,
          scopeLabel: `peer:${identity.peerId}`,
        })
      : undefined);
  const continuable = new PeerContinuableTaskRegistry({
    adapter,
    peerId: identity.peerId,
    // exactOptionalPropertyTypes: never pass explicit `undefined` for an
    // absent optional property.
    ...(options.verifyAfterExecute !== undefined
      ? { verifyAfterExecute: options.verifyAfterExecute }
      : {}),
    ...(verifyBudget !== undefined ? { verifyBudget } : {}),
    ...(options.settledTaskTtlMs !== undefined
      ? { settledTtlMs: options.settledTaskTtlMs }
      : {}),
  });
  const unwrap = <T>(method: string, params: unknown): T => {
    if (options.verifier !== undefined) {
      return unwrapEnvelope(
        method,
        params as { payload: T; signature: string },
        options.verifier.verify.bind(options.verifier),
      );
    }
    return params as T;
  };
  return async (method, params) => {
    const startedAt = Date.now();
    try {
      const result = await (async () => {
        switch (method) {
          case PEER_PING_METHOD:
            return {
              ok: true,
              peerId: identity.peerId,
              ...(identity.model !== undefined
                ? { model: identity.model }
                : {}),
            };
          case PEER_SUBMIT_METHOD: {
            const input = unwrap<ExecuteInput>(method, params);
            const executeResult = await adapter.execute(input);
            if (!options.verifyAfterExecute) {
              const response: PeerSubmitResponse = { result: executeResult };
              return response;
            }
            if (verifyBudget !== undefined) {
              const decision = verifyBudget.tryReserve();
              if (!decision.allowed) {
                options.onEvent?.({
                  type: "peer.response",
                  method,
                  peerId: identity.peerId,
                  ok: true,
                  durationMs: Date.now() - startedAt,
                  error: decision.skip.reason,
                });
                const response: PeerSubmitResponse = {
                  result: executeResult,
                  verifySkipped: { reason: decision.skip.reason },
                };
                return response;
              }
            }
            try {
              const verdicts = await adapter.verify({
                result: executeResult,
                objective: input.objective,
              });
              verifyBudget?.consume();
              const response: PeerSubmitResponse = {
                result: executeResult,
                verdict: combinePeerVerdicts(verdicts),
              };
              return response;
            } catch (err) {
              options.onEvent?.({
                type: "peer.response",
                method,
                peerId: identity.peerId,
                ok: true,
                durationMs: Date.now() - startedAt,
                error: `verify-after-execute failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              });
              const response: PeerSubmitResponse = { result: executeResult };
              return response;
            }
          }
          case PEER_SUBMIT_CONTINUABLE_METHOD: {
            const body = unwrap<PeerSubmitContinuableParams>(method, params);
            return continuable.start(body);
          }
          case PEER_SEND_METHOD: {
            const body = unwrap<PeerTaskControlParams>(method, params);
            continuable.send(body.correlationId, body.message ?? "");
            return { ok: true as const };
          }
          case PEER_CLOSE_METHOD: {
            const body = unwrap<PeerTaskControlParams>(method, params);
            continuable.close(body.correlationId);
            return { ok: true as const };
          }
          case PEER_INTERRUPT_METHOD: {
            const body = unwrap<PeerTaskControlParams>(method, params);
            continuable.interrupt(body.correlationId, body.reason);
            return { ok: true as const };
          }
          case PEER_STATUS_METHOD: {
            const body = unwrap<PeerTaskControlParams>(method, params);
            return continuable.status(body.correlationId);
          }
          case PEER_WAIT_SETTLE_METHOD: {
            const body = unwrap<PeerTaskControlParams>(method, params);
            return continuable.waitSettle(
              body.correlationId,
              body.timeoutMs ?? 120_000,
            );
          }
          case PEER_VERIFY_METHOD: {
            if (verifyBudget !== undefined) {
              const decision = verifyBudget.tryReserve();
              if (!decision.allowed) {
                throw new Error(decision.skip.reason);
              }
            }
            const verdicts = await adapter.verify(
              unwrap<VerifyInput>(method, params),
            );
            verifyBudget?.consume();
            return verdicts;
          }
          case PEER_MANIFEST_METHOD: {
            const input = (unwrap<Partial<BuildManifestInput>>(method, params ?? {}) ??
              {}) as Partial<BuildManifestInput>;
            const manifest = await adapter.buildManifest({
              peerId: identity.peerId,
              ownerId: identity.ownerId ?? identity.peerId,
              reputationBySkill: input.reputationBySkill ?? {},
            });
            return manifest as CapabilityManifest;
          }
          case PEER_SCOREBOARD_LIST_METHOD: {
            return options.scoreboard?.list() ?? [];
          }
          default:
            throw new Error(`unknown peer method: ${method}`);
        }
      })();
      options.onEvent?.({
        type: "peer.response",
        method,
        peerId: identity.peerId,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      options.onEvent?.({
        type: "peer.response",
        method,
        peerId: identity.peerId,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}
