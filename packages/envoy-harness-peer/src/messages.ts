/**
 * D2 — the standalone peer wire dialect (MAP-over-JSON-RPC, v1).
 *
 * JSON-RPC methods carried over the harness's existing framing
 * (`JsonRpcConnection` / Content-Length):
 *
 * - `peer/ping`     → `{ ok: true, peerId, model }` (readiness/identity)
 * - `peer/submit`   → `ExecuteInput` → `PeerSubmitResponse`
 *                     (`{ result, verdict? }` — the verdict is present
 *                     when the server ran `adapter.verify` after execute)
 * - `peer/submitContinuable` / `peer/send` / `peer/interrupt` /
 *   `peer/close` / `peer/status` — R4.9b continuable tasks
 * - `peer/verify`   → `VerifyInput` → `Verdict[]` (MAP verify)
 * - `peer/manifest` → `BuildManifestInput` → `CapabilityManifest`
 */

import type { SignedAgentResult, Verdict } from "@envoymesh/protocol";

export const PEER_PING_METHOD = "peer/ping";
export const PEER_SUBMIT_METHOD = "peer/submit";
export const PEER_VERIFY_METHOD = "peer/verify";
export const PEER_MANIFEST_METHOD = "peer/manifest";
/** R4.9b — non-blocking continuable spawn. */
export const PEER_SUBMIT_CONTINUABLE_METHOD = "peer/submitContinuable";
export const PEER_SEND_METHOD = "peer/send";
export const PEER_INTERRUPT_METHOD = "peer/interrupt";
export const PEER_CLOSE_METHOD = "peer/close";
export const PEER_STATUS_METHOD = "peer/status";

/**
 * `peer/submit` response body. `verdict` is additive: present when the
 * server-side `verifyAfterExecute` is enabled, absent otherwise (the
 * client falls back to its v1 placeholder verdict).
 */
export interface PeerSubmitResponse {
  result: SignedAgentResult;
  verdict?: Verdict;
}

/** `peer/ping` response body. */
export interface PeerPingResult {
  ok: true;
  /** The peer's identity / model advertisement (v1: echo of caller). */
  peerId?: string;
  model?: string;
}

/** ExecuteInput without AbortSignal (not JSON-serializable). */
export type WireExecuteInput = {
  skillId: string;
  objective: string;
  inputArtifacts: unknown[];
  costCeilingUsd: number;
  deadlineMs: number;
  correlationId: string;
};

export interface PeerSubmitContinuableParams {
  correlationId: string;
  input: WireExecuteInput;
}

export interface PeerSubmitContinuableResult {
  correlationId: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "partial";
  /** True when this correlationId was already registered. */
  idempotent?: boolean;
}

export interface PeerTaskControlParams {
  correlationId: string;
  reason?: string;
  message?: string;
}

export interface PeerTaskStatusResult {
  correlationId: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "partial";
  settled: boolean;
  result?: PeerSubmitResponse;
  objective: string;
  capabilityTag: string;
  startedAt: string;
  completedAt?: string;
  costUsd?: number;
  durationMs?: number;
}
