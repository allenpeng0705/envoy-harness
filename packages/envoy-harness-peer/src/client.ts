/**
 * D2 — `PeerClient`: a typed JSON-RPC client for a standalone
 * envoy-harness peer. Wraps a `JsonRpcConnection` (the shared framing
 * from the ACP/SDK codec) and exposes the peer dialect.
 */

import {
  JsonRpcConnection,
  type SubagentInput,
  type SubagentResult,
} from "@envoymesh/envoy-harness";
import type {
  BuildManifestInput,
  ExecuteInput,
  VerifyInput,
} from "@envoymesh/agent-adapter";
import type {
  CapabilityManifest,
  SignedAgentResult,
  Verdict,
} from "@envoymesh/protocol";

import {
  PEER_MANIFEST_METHOD,
  PEER_PING_METHOD,
  PEER_SUBMIT_METHOD,
  PEER_VERIFY_METHOD,
  type PeerSubmitResponse,
} from "./messages.js";
import {
  signedResultToSubagentResult,
  subagentInputToExecuteInput,
} from "./mapping.js";
import { wrapEnvelope, type PeerSigner } from "./envelope.js";
import type { PeerEventSink } from "./events.js";

export interface PeerClientOptions {
  connection: JsonRpcConnection;
  /** Request timeout for each call (default 30s). */
  requestTimeoutMs?: number;
  /**
   * Extra budget added to `peer/submit`'s timeout on top of the task's
   * `deadlineMs` (default 5s). The peer runs its own model under the
   * deadline; the buffer covers transport + JSON-RPC framing. Widen it
   * for hosts on slow links / busy nodes with short-deadline tasks.
   */
  submitResponseBufferMs?: number;
  /** D7 — when set, every request is enveloped with a signature. */
  signer?: PeerSigner;
  /** D7 — observability sink for request/response events. */
  onEvent?: PeerEventSink;
}

export class PeerClient {
  readonly #connection: JsonRpcConnection;
  readonly #requestTimeoutMs: number;
  readonly #submitResponseBufferMs: number;
  readonly #signer: PeerSigner | undefined;
  readonly #onEvent: PeerEventSink | undefined;

  constructor(options: PeerClientOptions) {
    this.#connection = options.connection;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#submitResponseBufferMs = options.submitResponseBufferMs ?? 5_000;
    this.#signer = options.signer;
    this.#onEvent = options.onEvent;
  }

  /** `peer/ping` — readiness + identity advertisement. */
  async ping(): Promise<{ ok: true; peerId?: string; model?: string }> {
    return this.#send(
      PEER_PING_METHOD,
      {},
      this.#requestTimeoutMs,
      undefined,
      "peer ping aborted",
    ) as Promise<{ ok: true; peerId?: string; model?: string }>;
  }

  /** `peer/submit` — submit a task to the peer and await the result. */
  async submit(
    input: SubagentInput,
    signal?: AbortSignal,
  ): Promise<SubagentResult> {
    // Convenience: MeshSubmitter-shaped submit → MAP execute → map back.
    const wire = await this.executeWithVerdict(
      subagentInputToExecuteInput(
        input,
        signal ?? new AbortController().signal,
      ),
      signal,
    );
    return signedResultToSubagentResult(wire.result, wire.verdict);
  }

  /**
   * `peer/submit` — MAP `ExecuteInput` → the submit response (signed
   * result + optional server verdict).
   */
  async executeWithVerdict(
    input: ExecuteInput,
    signal?: AbortSignal,
  ): Promise<PeerSubmitResponse> {
    return this.#send(
      PEER_SUBMIT_METHOD,
      input,
      input.deadlineMs + this.#submitResponseBufferMs,
      signal,
      "peer submit aborted",
    ) as Promise<PeerSubmitResponse>;
  }

  /** `peer/submit` — MAP `ExecuteInput` → `SignedAgentResult` (verdict dropped). */
  async execute(
    input: ExecuteInput,
    signal?: AbortSignal,
  ): Promise<SignedAgentResult> {
    return (await this.executeWithVerdict(input, signal)).result;
  }

  /** `peer/verify` — ask the peer to verify a result. */
  async verify(input: VerifyInput, signal?: AbortSignal): Promise<Verdict[]> {
    return this.#send(
      PEER_VERIFY_METHOD,
      input,
      this.#requestTimeoutMs,
      signal,
      "peer verify aborted",
    ) as Promise<Verdict[]>;
  }

  /** `peer/manifest` — the peer's capability manifest. */
  async manifest(
    input: BuildManifestInput,
    signal?: AbortSignal,
  ): Promise<CapabilityManifest> {
    return this.#send(
      PEER_MANIFEST_METHOD,
      input,
      this.#requestTimeoutMs,
      signal,
      "peer manifest aborted",
    ) as Promise<CapabilityManifest>;
  }

  async #send<T>(
    method: string,
    payload: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    abortMessage: string,
  ): Promise<T> {
    const startedAt = Date.now();
    this.#onEvent?.({ type: "peer.request", method, startedAt });
    const params =
      this.#signer !== undefined
        ? wrapEnvelope(method, payload, this.#signer.sign.bind(this.#signer))
        : payload;
    const requestPromise = this.#connection.request(
      method,
      params,
      timeoutMs,
    ) as Promise<T>;
    try {
      const result = await this.#race(requestPromise, signal, abortMessage);
      this.#onEvent?.({
        type: "peer.response",
        method,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      this.#onEvent?.({
        type: "peer.response",
        method,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async #race<T>(
    requestPromise: Promise<T>,
    signal: AbortSignal | undefined,
    abortMessage: string,
  ): Promise<T> {
    if (signal === undefined) return requestPromise;
    if (signal.aborted) throw new Error(abortMessage);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error(abortMessage));
      signal.addEventListener("abort", onAbort, { once: true });
      requestPromise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }
}
