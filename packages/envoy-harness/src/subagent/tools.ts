/**
 * `makeTaskTool` — the `task` tool the parent agent
 * uses to spawn a sub-agent.
 *
 * **Design doc:** §10.3 ("The task tool —
 * mesh-native sub-agent"). The `task` tool is the
 * parent's escape hatch: when the model decides
 * "this needs a different perspective" or "I need a
 * specialist", it calls the tool; the tool submits
 * to the `MeshSubmitter`; the submitter runs (or
 * routes) the sub-agent and returns the result.
 *
 * **Why a factory, not a singleton:** the tool
 * closes over the `MeshSubmitter` (the host injects
 * the implementation). Different hosts can wire
 * different submitters (`LocalMeshSubmitter`,
 * `NoopMeshSubmitter`, or a future
 * `RemoteMeshSubmitter`).
 *
 * **Why a tool, not an `Agent.run` option:** tools
 * are how the model expresses "I need help". The
 * model decides WHEN to spawn a sub-agent based
 * on the task. Making it a tool means the model
 * sees the tool in its tool list and decides
 * dynamically.
 *
 * **What the tool returns:** the `SubagentResult`
 * (the parent's view of what the sub-agent did).
 * The model sees the result and decides what to
 * do next (e.g. continue, retry, or report back
 * to the user).
 *
 * **Stability:** additive. New fields on the
 * `TaskInput` / `TaskResult` (the tool's input /
 * output) are additive.
 */

import { z } from "zod";

import type { ContentBlock, Tool } from "../tools/types.js";
import type { MeshSubmitter } from "./types.js";

/** The tool's input schema (zod). */
export const TaskInputSchema = z.object({
  objective: z
    .string()
    .min(1)
    .describe("What the sub-agent should do. Free-form."),
  capability_tag: z
    .string()
    .min(1)
    .describe(
      "A free-form tag the orchestrator (or local router) uses to " +
        "pick the right runtime + tools. Examples: 'code-search', " +
        "'summarize', 'code-edit', 'doc-search'.",
    ),
  cost_ceiling_usd: z
    .number()
    .positive()
    .describe("Cost ceiling in USD. The sub-agent's run is bounded by this."),
  deadline_ms: z
    .number()
    .int()
    .positive()
    .describe("Wall-clock deadline in ms from now."),
  preferred_peer_id: z
    .string()
    .optional()
    .describe(
      "Optional: prefer a specific peer (mesh routing hint). v0's " +
        "LocalMeshSubmitter ignores this; a future RemoteMeshSubmitter " +
        "uses it.",
    ),
  preferred_runtime: z
    .string()
    .optional()
    .describe(
      "Optional: prefer a specific runtime. v0's LocalMeshSubmitter " +
        "ignores this.",
    ),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;

/**
 * The tool's `execute` returns the full
 * `SubagentResult` (status + content + verdict +
 * cost + duration). The model sees the whole
 * picture; it can pick which fields to surface
 * in its next user-facing reply.
 *
 * **The result is wrapped in a tool result.** The
 * agent's loop converts it to a `tool_result` block
 * in the parent's transcript.
 */
export type TaskResult = {
  status: "completed" | "failed" | "partial";
  content: ReadonlyArray<ContentBlock>;
  workerPeerId: string;
  workerRuntime: string;
  costUsd: number;
  durationMs: number;
  verdict: unknown; // wire-friendly shape; the Verdict union is the source of truth
  signature: string;
};

/**
 * Build the `task` tool. The host provides the
 * `MeshSubmitter`; the tool calls it on every
 * invocation. The factory exists so multiple
 * agents can use different submitters (e.g. one
 * parent uses `LocalMeshSubmitter`, another uses
 * a future `RemoteMeshSubmitter`).
 */
export function makeTaskTool(submitter: MeshSubmitter): Tool {
  return {
    name: "task",
    description:
      "Spawn a sub-agent. The sub-agent runs in a NEW local session " +
      "(own permission state, own transcript) and may run on this " +
      "node or a peer in the mesh. Returns the sub-agent's final " +
      "text + verdict + cost. Use this when a sub-problem deserves " +
      "a fresh session with its own permission state — e.g. a " +
      "research sub-agent that should run read-only while you " +
      "continue to edit files.",
    parameters: TaskInputSchema,
    async execute(args, ctx) {
      const result = await submitter.submit(
        {
          objective: args.objective,
          capabilityTag: args.capability_tag,
          costCeilingUsd: args.cost_ceiling_usd,
          deadlineMs: args.deadline_ms,
          ...(args.preferred_peer_id !== undefined
            ? { preferredPeerId: args.preferred_peer_id }
            : {}),
          ...(args.preferred_runtime !== undefined
            ? { preferredRuntime: args.preferred_runtime as never }
            : {}),
        },
        ctx.abortSignal,
      );
      // Return the result as the tool's content.
      // The model sees the full picture; the loop
      // wraps it in a tool_result block.
      return { content: result };
    },
  };
}
