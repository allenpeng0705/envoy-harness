/**
 * Sub-agent types (§10.3 of the design — F10.1 Phase 5).
 *
 * **What is this module?** the public type surface for
 * the mesh-native sub-agent integration. The parent
 * agent calls the `task` tool; the tool submits to a
 * `MeshSubmitter`; the submitter runs (or routes) the
 * sub-agent and returns the result.
 *
 * **Why a separate "sub-agent" abstraction, not just
 * "call Agent.run()":** the design invariant #9 says
 * "sub-agents map to mesh chain steps, not in-process
 * tasks". A sub-agent is a fresh session, even locally.
 * The `MeshSubmitter` seam makes that explicit: the
 * parent doesn't directly call `new Agent()`; the
 * submitter decides the sub-agent's session, model,
 * tools, permission, and (in the future) whether the
 * sub-agent runs locally or on a peer.
 *
 * **Why envoy-harness owns these types:** the `task`
 * tool is a first-class harness tool. The seam
 * (`MeshSubmitter`) is the *interface*; the
 * implementation (`LocalMeshSubmitter`) is the
 * *default*. Both live in Package 1. The future
 * `RemoteMeshSubmitter` (cross-node) can live in
 * the adapter (Package 3) — the seam doesn't change.
 *
 * **What this is NOT:**
 * - Not a fork pattern. The sub-agent is a NEW
 *   `Agent` instance with a NEW `InMemorySession`.
 *   It does not share the parent's session, hooks,
 *   or permission.
 * - Not a thread. JS is single-threaded; the
 *   "sub-agent runs in parallel" semantic is the
 *   host's concern (the host can `Promise.all` over
 *   multiple `submitter.submit()` calls if it wants
 *   concurrency).
 * - Not the F9.3 Team pattern. F9.3 Team is a
 *   pre-defined graph of agents in TOML, all
 *   sharing the parent's tool registry. F10.1
 *   sub-agents are dynamic, single-shot, with
 *   their own session.
 *
 * **Stability:** additive. New fields on
 * `SubagentInput` or `SubagentResult` are
 * additive; removing a field is a major version.
 */

import type { AgentRuntime } from "../types.js";
import type { ContentBlock } from "../tools/types.js";
import type { Verdict } from "../types.js";

/**
 * The parent's view of "what to ask the sub-agent
 * to do". The `MeshSubmitter` decides how to run it
 * (locally, on a peer, etc.).
 */
export interface SubagentInput {
  /** The sub-agent's task. Free-form. */
  objective: string;
  /**
   * A free-form tag the orchestrator (or local
   * router) uses to pick the right runtime + tools.
   * v0: not interpreted by `LocalMeshSubmitter`;
   * the host can override the factory to use it.
   */
  capabilityTag: string;
  /** Cost ceiling in USD. The sub-agent's run is
   *  bounded by this. */
  costCeilingUsd: number;
  /** Wall-clock deadline in ms from now. */
  deadlineMs: number;
  /** Optional: prefer a specific peer (mesh routing
   *  hint). v0's `LocalMeshSubmitter` ignores this. */
  preferredPeerId?: string;
  /** Optional: prefer a specific runtime. v0's
   *  `LocalMeshSubmitter` ignores this. */
  preferredRuntime?: AgentRuntime;
}

/**
 * The result of a sub-agent's run. The parent sees
 * this as the `task` tool's return value.
 */
export interface SubagentResult {
  /** Overall status. "completed" if the sub-agent
   *  finished cleanly; "failed" if it aborted;
   *  "partial" if it ran but the verdict was
   *  partial/disputed. */
  status: "completed" | "failed" | "partial";
  /** The sub-agent's final content blocks. */
  content: ReadonlyArray<ContentBlock>;
  /** The worker's peerId. Stamped into the result. */
  workerPeerId: string;
  /** The worker's runtime. v0: always "envoy-harness". */
  workerRuntime: AgentRuntime;
  /** The sub-agent's cost in USD. */
  costUsd: number;
  /** The sub-agent's wall-clock duration in ms. */
  durationMs: number;
  /**
   * The sub-agent's verdict. v0: a simple synthesis
   * from the agent's `stopReason` + content shape.
   * Future: the mesh orchestrator's verdict.
   */
  verdict: Verdict;
  /**
   * v0: empty string. Local execution doesn't need
   * cryptographic trust (parent + sub-agent are in
   * the same process). Future cross-node: Ed25519
   * over the canonical result, signed with the
   * worker's owner key.
   */
  signature: string;
}

/**
 * The seam between the `task` tool and the actual
 * sub-agent execution. The default implementation
 * (`LocalMeshSubmitter`) runs the sub-agent in a
 * NEW local session. Future implementations may
 * route to a peer (via the EnvoyMesh orchestrator)
 * or to a different runtime (e.g. openclaw).
 *
 * **Why an interface, not a class:** the host
 * decides. The `LocalMeshSubmitter` is the default
 * for testing + local dev. Production hosts may
 * inject a custom submitter (e.g. one that also
 * broadcasts the subtask to bonded peers for
 * off-node execution).
 *
 * **Why `submit` is async:** the sub-agent is
 * async. A cross-node submitter may also be
 * async (network round-trip). A local submitter
 * is also async (the agent's `run()` is async).
 *
 * **The signal:** the parent's abort signal.
 * Submit-terrain honor it (the agent's loop checks
 * the signal at every iteration boundary). The
 * submitter's `submit()` should also pass the
 * signal through to the sub-agent's `run()`.
 */
export interface MeshSubmitter {
  submit(input: SubagentInput, signal: AbortSignal): Promise<SubagentResult>;
}
