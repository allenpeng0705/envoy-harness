/**
 * Per-iteration settings snapshot.
 *
 * **The problem.** The run loop reads live agent state on every
 * iteration — deliberately, so the REPL's `/model` and `/sandbox` take
 * effect mid-session. The cost is that a *single* model request can mix
 * configurations that never existed together: the model resolved before
 * a `/model` swap, the tool list filtered by a collaboration mode read
 * one line earlier, the sandbox policy read at dispatch time, and the
 * hook registry read when a tool finally runs. Such a turn is neither
 * the old configuration nor the new one, which makes it impossible to
 * replay, diff, or reason about — and it is hostile to prompt caching.
 *
 * **The fix.** Capture one immutable snapshot per iteration and use it
 * for that whole iteration. Swaps stay live: they are published and
 * adopted at the *next* iteration boundary. The REPL ergonomics are
 * unchanged; a single request is now internally consistent.
 *
 * **Deliberate asymmetry — tools still read the policy live.** The
 * snapshot governs the model *request*. Tool execution continues to read
 * `sandboxPolicy`/`approval` through live getters, because for a tool
 * that is the SAFER choice: if the user downgrades to read-only
 * mid-turn, the very next tool call must honour it rather than waiting
 * for the next iteration. Consistency matters for the request (it is
 * cached and replayed); immediacy matters for enforcement.
 */

import type { Agent } from "../agent.js";
import type { ModelAdapter } from "../model.js";
import type { Tool } from "../tools/types.js";
import type { CollaborationModeState } from "../plan/mode-kind.js";
import type { PermissionMode, SandboxPolicy } from "../types.js";
import type { RetryPolicy } from "../llm/retry.js";

export interface StepSnapshot {
  readonly turnId: string;
  readonly iteration: number;
  /** The model adapter captured for this iteration. */
  readonly model: ModelAdapter;
  /** Model-visible tool set, already filtered for the collaboration mode. */
  readonly tools: ReadonlyArray<Tool>;
  readonly sandboxPolicy: SandboxPolicy;
  readonly permissionMode: PermissionMode;
  readonly collaborationMode: CollaborationModeState;
  readonly maxIterations: number;
  readonly retryPolicy: RetryPolicy | undefined;
  /**
   * Stable identity for tracing: a change from one iteration to the next
   * explains a non-reproducible turn without diffing the whole agent.
   */
  readonly signature: string;
}

/** Stable, comparable description of a snapshot's configurable inputs. */
export function snapshotSignature(input: {
  model: ModelAdapter;
  tools: ReadonlyArray<{ name: string }>;
  sandboxPolicy: { mode: string; backend: string };
  collaborationMode: { kind: string };
}): string {
  return [
    `model:${input.model.constructor?.name ?? "adapter"}`,
    `tools:${input.tools
      .map((t) => t.name)
      .sort()
      .join(",")}`,
    `sandbox:${input.sandboxPolicy.mode}/${input.sandboxPolicy.backend}`,
    `mode:${input.collaborationMode.kind}`,
  ].join("|");
}

/**
 * Capture the settings that govern ONE iteration.
 *
 * `filterTools` is applied here so the tool list cannot change underneath
 * a request that was already prepared with the previous list.
 */
export function captureStep(
  agent: Agent,
  context: {
    turnId: string;
    iteration: number;
    filterTools: (tools: ReadonlyArray<Tool>) => ReadonlyArray<Tool>;
  },
): StepSnapshot {
  const tools = context.filterTools(agent.tools.list());
  const sandboxPolicy = agent.sandboxPolicy;
  const collaborationMode = agent.session.getCollaborationMode();
  return {
    turnId: context.turnId,
    iteration: context.iteration,
    model: agent.model,
    tools,
    sandboxPolicy,
    permissionMode: sandboxPolicy.mode,
    collaborationMode,
    maxIterations: agent.maxIterations,
    retryPolicy: agent.retryPolicy,
    signature: snapshotSignature({
      model: agent.model,
      tools,
      sandboxPolicy,
      collaborationMode,
    }),
  };
}

/**
 * Detect that a swap landed between iterations, for the trace.
 *
 * A user-facing notice is more useful than a silently different turn: it
 * explains why a turn behaved differently from the one before it.
 */
export function describeSnapshotChange(
  previous: StepSnapshot | undefined,
  next: StepSnapshot,
): string | undefined {
  if (previous === undefined) return undefined;
  if (previous.signature === next.signature) return undefined;
  const changes: string[] = [];
  if (previous.model !== next.model) changes.push("model");
  if (
    previous.tools.map((t) => t.name).join(",") !==
    next.tools.map((t) => t.name).join(",")
  ) {
    changes.push("tools");
  }
  if (previous.sandboxPolicy.mode !== next.sandboxPolicy.mode) {
    changes.push("sandbox");
  }
  if (previous.collaborationMode.kind !== next.collaborationMode.kind) {
    changes.push("mode");
  }
  if (changes.length === 0) return "configuration";
  return changes.join(", ");
}
