/**
 * Model-facing `workflow` tool — wraps host {@link parallel} / {@link pipeline}.
 *
 * DeepSeek exposes workflow as a blocking tool; envoy previously only had
 * the programmatic API in `workflow.ts`.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../tools/types.js";
import type { MeshSubmitter, SubagentInput, SubagentResult } from "./types.js";
import { parallel, pipeline } from "./workflow.js";

const WorkflowTaskSchema = z.object({
  objective: z.string().min(1).describe("What this step/child should do"),
  capability_tag: z
    .string()
    .min(1)
    .describe("Routing tag (e.g. research, code-search)"),
  cost_ceiling_usd: z
    .number()
    .positive()
    .describe("Cost ceiling in USD for this child"),
  deadline_ms: z
    .number()
    .int()
    .positive()
    .describe("Wall-clock deadline in ms for this child"),
  preferred_peer_id: z
    .string()
    .optional()
    .describe("Optional mesh peer routing hint"),
});

const WorkflowParams = z.object({
  mode: z
    .enum(["parallel", "pipeline"])
    .describe(
      "parallel: run all tasks concurrently and aggregate. " +
        "pipeline: run steps in order; each step sees prior text as context.",
    ),
  tasks: z
    .array(WorkflowTaskSchema)
    .min(1)
    .describe("Tasks (parallel) or ordered steps (pipeline)"),
  work_budget: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max children to admit (shared across the workflow)."),
  token_budget: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Shared token budget across children (when usage is reported)."),
});

function toInput(
  t: z.infer<typeof WorkflowTaskSchema>,
): SubagentInput {
  return {
    objective: t.objective,
    capabilityTag: t.capability_tag,
    costCeilingUsd: t.cost_ceiling_usd,
    deadlineMs: t.deadline_ms,
    ...(t.preferred_peer_id !== undefined
      ? { preferredPeerId: t.preferred_peer_id }
      : {}),
  };
}

function publicResult(r: SubagentResult): Record<string, unknown> {
  const text = r.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return {
    status: r.status,
    text: text.length > 0 ? text : "(no text)",
    cost_usd: r.costUsd,
    duration_ms: r.durationMs,
    worker_peer_id: r.workerPeerId,
  };
}

export interface MakeWorkflowToolOptions {
  submitter: MeshSubmitter;
  maxSubagents?: number;
  onSubagentComplete?: (result: SubagentResult) => void;
}

/** Build the blocking `workflow` tool bound to a mesh submitter. */
export function makeWorkflowTool(options: MakeWorkflowToolOptions): Tool {
  const { submitter, maxSubagents, onSubagentComplete } = options;

  return {
    name: "workflow",
    description:
      "Run an explicit multi-child workflow. mode=parallel fans out all " +
      "tasks at once and returns an aggregated result; mode=pipeline runs " +
      "steps in order, feeding each step the prior step's text. Blocks " +
      "until the workflow finishes (unlike run_in_background task). Prefer " +
      "this when you need structured parallel or sequential orchestration " +
      "in one tool call.",
    parameters: WorkflowParams,
    // Exclusive: owns many child sessions; do not parallelize with other tools.
    async execute(args, ctx): Promise<ToolResult> {
      const tasks = args.tasks.map(toInput);
      const onTaskComplete =
        onSubagentComplete !== undefined
          ? (result: SubagentResult) => {
              onSubagentComplete(result);
            }
          : undefined;

      try {
        const budgetOpts = {
          ...(args.work_budget !== undefined
            ? { workBudget: args.work_budget }
            : {}),
          ...(args.token_budget !== undefined
            ? { tokenBudget: args.token_budget }
            : {}),
        };
        if (args.mode === "parallel") {
          const out = await parallel(submitter, tasks, {
            signal: ctx.abortSignal,
            ...(maxSubagents !== undefined ? { maxSubagents } : {}),
            ...(onTaskComplete !== undefined ? { onTaskComplete } : {}),
            ...budgetOpts,
          });
          const failed = out.aggregated.status === "failed";
          return {
            content: JSON.stringify({
              mode: "parallel",
              results: out.results.map(publicResult),
              aggregated: publicResult(out.aggregated),
              ...(out.budgetExhausted === true
                ? { budget_exhausted: true }
                : {}),
            }),
            ...(failed ? { isError: true } : {}),
          };
        }

        const out = await pipeline(submitter, tasks, {
          signal: ctx.abortSignal,
          ...(onTaskComplete !== undefined ? { onTaskComplete } : {}),
          ...budgetOpts,
        });
        const failed = out.final.status === "failed";
        return {
          content: JSON.stringify({
            mode: "pipeline",
            results: out.results.map(publicResult),
            final: publicResult(out.final),
            ...(out.budgetExhausted === true
              ? { budget_exhausted: true }
              : {}),
          }),
          ...(failed ? { isError: true } : {}),
        };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
}
