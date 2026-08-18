/**
 * LocalMeshSubmitter — the default `MeshSubmitter`
 * that runs the sub-agent in a NEW local session.
 *
 * **What this module is:** the "real workable"
 * sub-agent. The parent's `task` tool calls
 * `submit(input, signal)`; the submitter:
 *
 * 1. Builds a fresh `Agent` via the injected
 *    `buildSubagent` factory.
 * 2. Wires the parent's `signal` to the new
 *    agent's abort (so a parent cancel propagates).
 * 3. Calls `agent.run(input.objective)`.
 * 4. Synthesizes a `SubagentResult` from the
 *    `AgentResult`.
 * 5. Returns the result.
 *
 * **Why a factory, not `new Agent(...)` directly:**
 * the host decides the sub-agent's *configuration*
 * (model, tools, hooks, permission, system prompt).
 * The LocalMeshSubmitter is the *plumbing* — the
 * factory is the *policy*. The default factory
 * (`defaultBuildSubagentFactory`) gives a
 * sensible "fresh local session" configuration;
 * the host can override per sub-agent or per
 * capability tag.
 *
 * **Why a NEW session every time:** per design
 * invariant #9, even local sub-agents are
 * independent sessions. The factory's
 * responsibility is to construct a fresh
 * `InMemorySession` (new id, new AGENTS.md, new
 * hooks) per call. The submitter just calls the
 * factory and runs.
 *
 * **Why "v0 unsigned":** the signature on the
 * `SubagentResult` is empty. The parent and the
 * sub-agent are in the same process; no
 * cryptographic trust is needed. The interface
 * supports a signed result (future cross-node
 * `RemoteMeshSubmitter`).
 *
 * **Stability:** additive. New options on the
 * constructor are additive; the `submit` signature
 * is closed (matches `MeshSubmitter`).
 */

import { Agent } from "../agent.js";
import { BUILTIN_TOOLS } from "../tools/builtin/index.js";
import { HookRegistry } from "../hooks/index.js";
import { InMemorySession, newSessionId } from "../session.js";
import { ToolRegistry } from "../tools/index.js";
import type { ModelAdapter } from "../model.js";
import type { PermissionMode } from "../types.js";
import type { Verdict } from "../verifier/types.js";

import type { MeshSubmitter, SubagentInput, SubagentResult } from "./types.js";

/** Options for `LocalMeshSubmitter`. */
export interface LocalMeshSubmitterOptions {
  /**
   * Factory: build a fresh `Agent` for the
   * sub-agent. The factory's responsibility is to
   * construct a NEW session (id, AGENTS.md, hooks)
   * per call. The host decides the sub-agent's
   * model, tools, permission, system prompt.
   *
   * **The factory may close over the parent's
   * configuration** (e.g. the parent's model) and
   * customize the sub-agent per call (different
   * `capabilityTag` → different tool set).
   */
  buildSubagent: (input: SubagentInput) => Agent;
  /**
   * This node's peerId. Stamped into every
   * `SubagentResult.workerPeerId` so the parent can
   * tell where the sub-agent ran.
   */
  workerPeerId: string;
}

/**
 * The default `MeshSubmitter` for local execution.
 *
 * **v0 limits:**
 * - The result is unsigned (local; no trust needed).
 * - The verdict is a simple synthesis from the
 *   agent's `stopReason` + content. Future:
 *   `runLocalVerifier(result.messages, input.objective)`.
 * - The parent's signal aborts the sub-agent's
 *   internal `AbortController` (next iteration
 *   boundary).
 * - Concurrency: v0 is single-threaded; the host
 *   can `Promise.all` over multiple `submit()`
 *   calls if it wants parallel sub-agents.
 */
export class LocalMeshSubmitter implements MeshSubmitter {
  private readonly buildSubagent: (input: SubagentInput) => Agent;
  private readonly workerPeerId: string;

  constructor(options: LocalMeshSubmitterOptions) {
    this.buildSubagent = options.buildSubagent;
    this.workerPeerId = options.workerPeerId;
  }

  async submit(
    input: SubagentInput,
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    const agent = this.buildSubagent(input);

    // Wire the parent's signal to the sub-agent's
    // abort. If the parent already aborted, fire
    // immediately; otherwise listen for the abort
    // event (once). The listener is removed in the
    // `finally` block to avoid leaks.
    const onAbort = (): void => {
      agent.abort(signal.reason);
    };
    if (signal.aborted) {
      agent.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const startedAt = Date.now();
    try {
      const result = await agent.run(input.objective);
      return synthesizeSubagentResult(result, this.workerPeerId, startedAt);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Synthesize a `SubagentResult` from the agent's
 * `AgentResult`. v0: simple stopReason-based
 * verdict. Future: call `runLocalVerifier` for a
 * proper verdict.
 *
 * **Status mapping:**
 * - `end_turn` / `tool_use` → `status: "completed"`,
 *   `verdict: pass` (placeholder; real verifier runs
 *   the 6 rules).
 * - `aborted` → `status: "failed"`,
 *   `verdict: fail`.
 * - `max_iterations` → `status: "failed"`,
 *   `verdict: fail` (the sub-agent didn't converge).
 * - `max_tokens` / `stop_sequence` →
 *   `status: "partial"`, `verdict: partial`.
 */
function synthesizeSubagentResult(
  result: import("../agent.js").AgentResult,
  workerPeerId: string,
  startedAt: number,
): SubagentResult {
  const verdict: Verdict = synthesizeVerdict(result);
  const status: SubagentResult["status"] =
    result.stopReason === "end_turn" || result.stopReason === "tool_use"
      ? "completed"
      : result.stopReason === "aborted" || result.stopReason === "max_iterations"
        ? "failed"
        : "partial";
  return {
    status,
    content: result.content,
    workerPeerId,
    workerRuntime: "envoy-harness",
    costUsd: result.metrics.costUsd,
    durationMs: Date.now() - startedAt,
    verdict,
    signature: "", // v0: local; no cryptographic trust needed
  };
}

/** v0 verdict synthesis. The score is a placeholder
 *  (real verification runs `runLocalVerifier`). */
function synthesizeVerdict(
  result: import("../agent.js").AgentResult,
): Verdict {
  switch (result.stopReason) {
    case "aborted":
      return { kind: "fail", reason: "sub-agent aborted", rollback: false };
    case "max_iterations":
      return {
        kind: "fail",
        reason: "sub-agent hit max iterations",
        rollback: false,
      };
    case "end_turn":
    case "tool_use":
      return { kind: "pass", score: 0.5, confidence: "medium" };
    default:
      return { kind: "partial", score: 0.5, reason: "sub-agent partial" };
  }
}

// ---------------------------------------------------------------------------
// Default factory: a fresh local session with BUILTIN_TOOLS + read-only
// ---------------------------------------------------------------------------

/** Options for the default factory. */
export interface DefaultBuildSubagentFactoryOptions {
  /** The sub-agent's model. */
  model: ModelAdapter;
  /** Working directory. Default: `process.cwd()`. */
  cwd?: string;
  /** Permission mode. Default: `"read-only"`. The
   *  sub-agent's own policy, not the requester's. */
  permissionMode?: PermissionMode;
  /** Optional system prompt prefix. The full system
   *  prompt is `prefix + "Sub-agent objective: " +
   *  objective`. */
  systemPromptPrefix?: string;
}

/**
 * The default `buildSubagent` factory: a fresh
 * `InMemorySession` + the BUILTIN_TOOLS + the given
 * model + read-only permission. The host can
 * override per sub-agent by injecting a different
 * factory.
 *
 * **The session is fresh per call.** `newSessionId()`
 * generates a new id; the `InMemorySession` is a
 * new object. The parent's session is never shared
 * with the sub-agent. This is the design invariant:
 * sub-agents are independent sessions, even locally.
 */
export function defaultBuildSubagentFactory(
  options: DefaultBuildSubagentFactoryOptions,
): (input: SubagentInput) => Agent {
  const cwd = options.cwd ?? process.cwd();
  const permissionMode = options.permissionMode ?? "read-only";
  const prefix = options.systemPromptPrefix ?? "";
  return (input: SubagentInput) => {
    const session = new InMemorySession(newSessionId(), {
      cwd,
      permissionMode,
      startedAt: new Date().toISOString(),
    });
    const tools = new ToolRegistry();
    for (const t of BUILTIN_TOOLS) tools.register(t);
    const hooks = new HookRegistry();
    const systemPrompt = [
      prefix,
      `You are a sub-agent invoked by the parent's \`task\` tool.`,
      `Capability tag: ${input.capabilityTag}`,
      `Objective: ${input.objective}`,
      `Stay within your cost ceiling ($${input.costCeilingUsd.toFixed(2)}) and deadline (${input.deadlineMs}ms).`,
      `Your permission mode is \`${permissionMode}\`.`,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
    return new Agent({
      model: options.model,
      tools,
      session,
      hooks,
      cwd,
      maxCostUsd: input.costCeilingUsd,
      systemPrompt,
    });
  };
}
