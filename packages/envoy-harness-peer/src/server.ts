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
import type {
  AgentAdapter,
  BuildManifestInput,
  ExecuteInput,
  VerifyInput,
} from "@envoymesh/agent-adapter";
import type { CapabilityManifest } from "@envoymesh/protocol";

import { combinePeerVerdicts } from "./scoreboard.js";
import {
  PEER_MANIFEST_METHOD,
  PEER_PING_METHOD,
  PEER_SUBMIT_METHOD,
  PEER_VERIFY_METHOD,
  type PeerSubmitResponse,
} from "./messages.js";
import { unwrapEnvelope, type PeerVerifier } from "./envelope.js";
import type { PeerEventSink } from "./events.js";

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
}

/** Build a JSON-RPC request handler for the peer dialect. */
export function createPeerServerHandler(
  options: PeerServerOptions,
): RequestHandler {
  const { adapter, identity } = options;
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
            try {
              const verdicts = await adapter.verify({
                result: executeResult,
                objective: input.objective,
              });
              const response: PeerSubmitResponse = {
                result: executeResult,
                verdict: combinePeerVerdicts(verdicts),
              };
              return response;
            } catch (err) {
              // A verifier hiccup must not discard a completed result:
              // return it without a verdict (client placeholder applies).
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
          case PEER_VERIFY_METHOD:
            return adapter.verify(unwrap<VerifyInput>(method, params));
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
