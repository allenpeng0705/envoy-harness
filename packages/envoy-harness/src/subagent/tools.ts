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
 * **F10.4.1 — capability-driven fan-out:** when
 * a `FanOutRegistry` is provided, the tool consults
 * it on every call. If a spec matches the input's
 * `capability_tag`, the tool expands ONE model
 * call into N parallel sub-agents (via
 * `Promise.all`), then aggregates the N results
 * into ONE for the model. The model sees ONE
 * call → ONE result; the host controls the
 * fan-out without teaching the model about it.
 *
 * **Stability:** additive. New fields on the
 * `TaskInput` / `TaskResult` (the tool's input /
 * output) are additive.
 */

import { z } from "zod";

import type { ContentBlock, Tool } from "../tools/types.js";
import { aggregateFanOutResults, type FanOutRegistry } from "./fan-out.js";
import type { MeshSubmitter, SubagentInput, SubagentResult } from "./types.js";

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

/** F10.4.1: options for `makeTaskTool`. The submitter is
 *  required; the `fanOutRegistry` is optional (no registry
 *  = no fan-out, F10.1 + F10.2 baseline). */
export interface MakeTaskToolOptions {
  submitter: MeshSubmitter;
  /**
   * F10.4.1: optional registry. When set, the tool
   * looks up the input's `capability_tag` on each
   * call. If a spec matches, the tool expands ONE
   * model call into N parallel sub-agents (per the
   * `FanOutSpec.count`), then aggregates the N
   * results into ONE.
   */
  fanOutRegistry?: FanOutRegistry;
  /**
   * F10.5: called after the `MeshSubmitter` (or the
   * F10.4.1 fan-out aggregator) returns. The parent
   * uses this to aggregate sub-agent cost into its
   * own `CostTracker` (via `addSubagentCost`).
   *
   * **Why the callback (not direct `CostTracker`
   * injection):** the tool doesn't know about the
   * parent's `CostTracker`. The callback hides the
   * wiring. The parent's `Agent` constructor wires
   * this callback to its own `costTracker.addSubagentCost`.
   *
   * **For fan-out:** the callback receives the
   * AGGREGATED result (with summed `costUsd`),
   * not the N individual results. The parent adds
   * the sum; the per-sub-agent breakdown is
   * available via the individual `SubagentResult`s
   * (not exposed in v0; future F10.6+).
   *
   * **The `SubagentResult` parameter:** the FULL
   * result, not just `costUsd`. The parent may
   * want to inspect other fields (e.g. `verdict`,
   * `durationMs`); keeping the surface small (one
   * callback with the whole result) is more
   * flexible than N callbacks.
   */
  onSubagentComplete?: (result: SubagentResult) => void;
  /**
   * F10.2: the parent's `maxSubagents` cap. The fan-out expansion
   * must honor it too: when `FanOutSpec.count > maxSubagents`, the
   * tool refuses ALL (same semantics as the parallel path). v0
   * expanded unconditionally, bypassing the cap.
   */
  maxSubagents?: number;
}

/**
 * Build the `task` tool. The host provides the
 * `MeshSubmitter`; the tool calls it on every
 * invocation. The factory exists so multiple
 * agents can use different submitters (e.g. one
 * parent uses `LocalMeshSubmitter`, another uses
 * a future `RemoteMeshSubmitter`).
 *
 * **F10.4.1 — fan-out:** when `fanOutRegistry` is
 * provided, the tool consults the registry. If a
 * spec matches the input's `capability_tag`, the
 * tool:
 * 1. Builds N `SubagentInput`s via the spec's
 *    `partition` function (or identity if not set).
 * 2. Calls `submitter.submit` N times in parallel
 *    via `Promise.all` (F10.2 fan-out path).
 * 3. Aggregates the N results into ONE
 *    `SubagentResult` for the model.
 * 4. Honors the parent's `abortSignal` (any
 *    sub-agent abort propagates to all in-flight).
 */
export function makeTaskTool(
  submitterOrOptions: MeshSubmitter | MakeTaskToolOptions,
): Tool {
  // Backward compat: F10.1.3 callers pass a
  // MeshSubmitter directly. F10.4.1+ callers pass
  // an options object. Both shapes are accepted.
  const submitter: MeshSubmitter =
    "submit" in submitterOrOptions
      ? submitterOrOptions
      : submitterOrOptions.submitter;
  const fanOutRegistry: FanOutRegistry | undefined =
    "submit" in submitterOrOptions
      ? undefined
      : submitterOrOptions.fanOutRegistry;
  const onSubagentComplete: ((result: SubagentResult) => void) | undefined =
    "submit" in submitterOrOptions
      ? undefined
      : submitterOrOptions.onSubagentComplete;
  const maxSubagents: number | undefined =
    "submit" in submitterOrOptions
      ? undefined
      : submitterOrOptions.maxSubagents;

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
      const baseInput: SubagentInput = {
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
      };

      // F10.4.1: fan-out expansion. Check the
      // registry first; if a spec matches, expand
      // to N parallel sub-agents.
      const spec = fanOutRegistry?.lookup(baseInput.capabilityTag);
      let result: SubagentResult;
      if (spec) {
        if (spec.count < 1) {
          // Defensive: invalid spec. Refuse all.
          result = {
            status: "failed",
            content: [
              {
                type: "text",
                text: `FanOutSpec for "${spec.capabilityTag}" has invalid count ${spec.count}; must be >= 1.`,
              },
            ],
            workerPeerId: "",
            workerRuntime: "envoy-harness",
            costUsd: 0,
            durationMs: 0,
            verdict: {
              kind: "fail",
              reason: "invalid FanOutSpec count",
              rollback: false,
            },
            signature: "",
          };
        } else if (maxSubagents !== undefined && spec.count > maxSubagents) {
          // F10.2 cap applies to the expanded count too.
          result = {
            status: "failed",
            content: [
              {
                type: "text",
                text: `maxSubagents reached: FanOutSpec for "${spec.capabilityTag}" expands to ${spec.count} sub-agents (cap is ${maxSubagents}). Refused.`,
              },
            ],
            workerPeerId: "",
            workerRuntime: "envoy-harness",
            costUsd: 0,
            durationMs: 0,
            verdict: {
              kind: "fail",
              reason: "maxSubagents exceeded by FanOutSpec",
              rollback: false,
            },
            signature: "",
          };
        } else {
          const partition = spec.partition ?? ((input) => input);
          const inputs: SubagentInput[] = [];
          for (let i = 0; i < spec.count; i++) {
            inputs.push(partition(baseInput, i, spec.count));
          }
          // Parallel run (F10.2 path). Abort propagates
          // via the shared `ctx.abortSignal`; each
          // sub-agent's submitter honors it.
          const results = await Promise.all(
            inputs.map((input) => submitter.submit(input, ctx.abortSignal)),
          );
          result = aggregateFanOutResults(results);
        }
      } else {
        // No fan-out: single sub-agent (F10.1 baseline).
        result = await submitter.submit(baseInput, ctx.abortSignal);
      }

      // F10.5: cost aggregation callback. Fires
      // AFTER the submitter (or fan-out aggregator)
      // returns, with the final result. For
      // fan-out, the parent sees the AGGREGATED
      // result (with summed costUsd), not the N
      // individual ones.
      if (onSubagentComplete) {
        onSubagentComplete(result);
      }
      return { content: result };
    },
  };
}
