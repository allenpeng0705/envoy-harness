/**
 * D2 — `PeerClient`: a typed JSON-RPC client for a standalone
 * envoy-harness peer. Wraps a `JsonRpcConnection` (the shared framing
 * from the ACP/SDK codec) and exposes the peer dialect.
 */

import {
  JsonRpcConnection,
  type ExecReadResult,
  type ExecShellRequest,
  type ExecShellResult,
  type JobRead,
  type JobSnapshot,
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
  VerdictEntry,
} from "@envoymesh/protocol";

import {
  PEER_CLOSE_METHOD,
  PEER_EXEC_READ_METHOD,
  PEER_EXEC_SHELL_METHOD,
  PEER_EXEC_WRITE_METHOD,
  PEER_INTERRUPT_METHOD,
  PEER_JOBS_FETCH_METHOD,
  PEER_JOBS_KILL_METHOD,
  PEER_JOBS_LIST_METHOD,
  PEER_JOBS_READ_METHOD,
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
  type PeerSubmitContinuableResult,
  type PeerSubmitResponse,
  type PeerTaskControlParams,
  type PeerTaskStatusResult,
  type WireExecuteInput,
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

  /** R4.9b — `peer/submitContinuable` (non-blocking spawn). */
  async submitContinuable(
    params: PeerSubmitContinuableParams,
    signal?: AbortSignal,
  ): Promise<PeerSubmitContinuableResult> {
    return this.#send(
      PEER_SUBMIT_CONTINUABLE_METHOD,
      params,
      this.#requestTimeoutMs,
      signal,
      "peer submitContinuable aborted",
    ) as Promise<PeerSubmitContinuableResult>;
  }

  /** R4.9b — enqueue a follow-up message for a continuable task. */
  async sendTask(
    params: PeerTaskControlParams,
    signal?: AbortSignal,
  ): Promise<{ ok: true }> {
    return this.#send(
      PEER_SEND_METHOD,
      params,
      this.#requestTimeoutMs,
      signal,
      "peer send aborted",
    ) as Promise<{ ok: true }>;
  }

  /** R4.9b — mark no further inbox messages. */
  async closeTask(
    params: PeerTaskControlParams,
    signal?: AbortSignal,
  ): Promise<{ ok: true }> {
    return this.#send(
      PEER_CLOSE_METHOD,
      params,
      this.#requestTimeoutMs,
      signal,
      "peer close aborted",
    ) as Promise<{ ok: true }>;
  }

  /** R4.9b — abort in-flight execute for a continuable task. */
  async interruptTask(
    params: PeerTaskControlParams,
    signal?: AbortSignal,
  ): Promise<{ ok: true }> {
    return this.#send(
      PEER_INTERRUPT_METHOD,
      params,
      this.#requestTimeoutMs,
      signal,
      "peer interrupt aborted",
    ) as Promise<{ ok: true }>;
  }

  /** R4.9b — poll lifecycle + optional settled result. */
  async taskStatus(
    params: PeerTaskControlParams,
    signal?: AbortSignal,
  ): Promise<PeerTaskStatusResult> {
    return this.#send(
      PEER_STATUS_METHOD,
      params,
      this.#requestTimeoutMs,
      signal,
      "peer status aborted",
    ) as Promise<PeerTaskStatusResult>;
  }

  /** R4.9b — block until settled (server-side wait, not client poll). */
  async waitTaskSettle(
    params: PeerTaskControlParams,
    signal?: AbortSignal,
  ): Promise<PeerTaskStatusResult> {
    const timeoutMs = params.timeoutMs ?? 120_000;
    return this.#send(
      PEER_WAIT_SETTLE_METHOD,
      { ...params, timeoutMs },
      timeoutMs + this.#submitResponseBufferMs,
      signal,
      "peer waitSettle aborted",
    ) as Promise<PeerTaskStatusResult>;
  }

  /** Helper: strip AbortSignal for wire transport. */
  static toWireExecuteInput(input: ExecuteInput): WireExecuteInput {
    return {
      skillId: input.skillId,
      objective: input.objective,
      inputArtifacts: input.inputArtifacts as unknown[],
      costCeilingUsd: input.costCeilingUsd,
      deadlineMs: input.deadlineMs,
      correlationId: input.correlationId,
    };
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

  /** R4.11 — `peer/scoreboard/list` — VerdictEntry records for federation. */
  async listScoreboard(signal?: AbortSignal): Promise<VerdictEntry[]> {
    return this.#send(
      PEER_SCOREBOARD_LIST_METHOD,
      {},
      this.#requestTimeoutMs,
      signal,
      "peer scoreboard/list aborted",
    ) as Promise<VerdictEntry[]>;
  }

  /** R5.1 — `peer/jobs/fetch`. */
  async jobsFetch(jobId: string, signal?: AbortSignal): Promise<JobSnapshot> {
    return this.#send(
      PEER_JOBS_FETCH_METHOD,
      { jobId },
      this.#requestTimeoutMs,
      signal,
      "peer jobs/fetch aborted",
    ) as Promise<JobSnapshot>;
  }

  /** R5.1 — `peer/jobs/read`. */
  async jobsRead(jobId: string, signal?: AbortSignal): Promise<JobRead> {
    return this.#send(
      PEER_JOBS_READ_METHOD,
      { jobId },
      this.#requestTimeoutMs,
      signal,
      "peer jobs/read aborted",
    ) as Promise<JobRead>;
  }

  /** R5.1 — `peer/jobs/kill`. */
  async jobsKill(
    jobId: string,
    signal?: AbortSignal,
    reason?: string,
  ): Promise<"requested" | "already-finished"> {
    return this.#send(
      PEER_JOBS_KILL_METHOD,
      { jobId, ...(reason !== undefined ? { reason } : {}) },
      this.#requestTimeoutMs,
      signal,
      "peer jobs/kill aborted",
    ) as Promise<"requested" | "already-finished">;
  }

  /** R5.1 — `peer/jobs/list`. */
  async jobsList(signal?: AbortSignal): Promise<JobSnapshot[]> {
    return this.#send(
      PEER_JOBS_LIST_METHOD,
      {},
      this.#requestTimeoutMs,
      signal,
      "peer jobs/list aborted",
    ) as Promise<JobSnapshot[]>;
  }

  /** R5.2 — `peer/exec/read`. */
  async execRead(
    path: string,
    options: { maxBytes?: number },
    signal?: AbortSignal,
  ): Promise<ExecReadResult> {
    return this.#send(
      PEER_EXEC_READ_METHOD,
      {
        path,
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      },
      this.#requestTimeoutMs,
      signal,
      "peer exec/read aborted",
    ) as Promise<ExecReadResult>;
  }

  /** R5.2 — `peer/exec/write`. */
  async execWrite(
    path: string,
    content: string,
    options: { createDirectories?: boolean },
    signal?: AbortSignal,
  ): Promise<{ ok: true }> {
    return this.#send(
      PEER_EXEC_WRITE_METHOD,
      {
        path,
        content,
        ...(options.createDirectories !== undefined
          ? { createDirectories: options.createDirectories }
          : {}),
      },
      this.#requestTimeoutMs,
      signal,
      "peer exec/write aborted",
    ) as Promise<{ ok: true }>;
  }

  /** R5.2 — `peer/exec/shell`. */
  async execShell(
    request: ExecShellRequest,
    signal?: AbortSignal,
  ): Promise<ExecShellResult> {
    return this.#send(
      PEER_EXEC_SHELL_METHOD,
      {
        command: request.command,
        cwd: request.cwd,
        ...(request.env !== undefined ? { env: request.env } : {}),
        ...(request.timeoutMs !== undefined
          ? { timeoutMs: request.timeoutMs }
          : {}),
      },
      (request.timeoutMs ?? 30_000) + this.#submitResponseBufferMs,
      signal,
      "peer exec/shell aborted",
    ) as Promise<ExecShellResult>;
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
