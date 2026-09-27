/**
 * `makeTaskTool` — the `task` tool the parent agent
 * uses to spawn a sub-agent (or a batch via `tasks[]`).
 */

import { z } from "zod";

import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from "../agent/tool-scheduler.js";
import type { ContentBlock, Tool } from "../tools/types.js";
import { mapBoundedParallel } from "./bounded-parallel.js";
import { aggregateFanOutResults, type FanOutRegistry } from "./fan-out.js";
import {
  spawnBackgroundSubagent,
  supportsContinuable,
} from "./background.js";
import type { MeshSubmitter, SubagentInput, SubagentResult } from "./types.js";

const TaskItemSchema = z.object({
  objective: z.string().min(1).describe("What this child should do."),
  capability_tag: z
    .string()
    .min(1)
    .optional()
    .describe("Overrides the parent call's capability_tag when set."),
  cost_ceiling_usd: z
    .number()
    .positive()
    .optional()
    .describe("Overrides the parent call's cost_ceiling_usd when set."),
  deadline_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Overrides the parent call's deadline_ms when set."),
});

/** Field shape visible to the model (before cross-field refine). */
export const TaskInputObjectSchema = z.object({
  objective: z
    .string()
    .min(1)
    .optional()
    .describe(
      "What the sub-agent should do. Required unless `tasks` is set.",
    ),
  capability_tag: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Routing tag (e.g. code-search, summarize). Required for a single " +
        "spawn, or as the default for items in `tasks`.",
    ),
  cost_ceiling_usd: z
    .number()
    .positive()
    .optional()
    .describe(
      "Cost ceiling in USD. Required for a single spawn, or as the " +
        "default for items in `tasks`.",
    ),
  deadline_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Wall-clock deadline in ms. Required for a single spawn, or as " +
        "the default for items in `tasks`.",
    ),
  preferred_peer_id: z
    .string()
    .optional()
    .describe(
      "Optional: prefer a specific peer (mesh routing hint). " +
        "LocalMeshSubmitter ignores it; a peer-backed submitter " +
        "(standalone peer cluster) routes by it. Read the `peers` tool " +
        "to discover peer ids/models.",
    ),
  preferred_runtime: z
    .string()
    .optional()
    .describe(
      "Optional: prefer a specific runtime. v0's LocalMeshSubmitter " +
        "ignores this.",
    ),
  tasks: z
    .array(TaskItemSchema)
    .min(1)
    .optional()
    .describe(
      "Spawn several sub-agents in one call. Each item needs an " +
        "objective; capability_tag / cost_ceiling_usd / deadline_ms " +
        "inherit from the parent fields when omitted. Length is capped " +
        "by maxSubagents. Prefer this or multiple task calls in one " +
        "assistant message for independent parallel work.",
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "When true, start without waiting and return job id(s) so you can " +
        "keep working. Watch with job_* / wait_agents; cancel with " +
        "job_kill; steer continuable children with send_message.",
    ),
  background_mode: z
    .enum(["one-shot", "continuable"])
    .optional()
    .describe(
      "Only meaningful with run_in_background, and REJECTED without it. " +
        "'one-shot' (default) runs the objective and finishes. " +
        "'continuable' keeps the child alive after its first turn so you " +
        "can send follow-up messages to it; you must eventually stop it " +
        "with job_kill. A continuable child is still bounded by " +
        "deadline_ms — measured from when it started, not per message — so " +
        "size that budget for the whole conversation.",
    ),
});

/** The tool's input schema (zod), including cross-field checks. */
export const TaskInputSchema = TaskInputObjectSchema.superRefine((data, ctx) => {
    const hasTasks = data.tasks !== undefined && data.tasks.length > 0;
    if (hasTasks) {
      for (let i = 0; i < data.tasks!.length; i++) {
        const t = data.tasks![i]!;
        const tag = t.capability_tag ?? data.capability_tag;
        const cost = t.cost_ceiling_usd ?? data.cost_ceiling_usd;
        const deadline = t.deadline_ms ?? data.deadline_ms;
        if (tag === undefined || cost === undefined || deadline === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `tasks[${i}] needs capability_tag, cost_ceiling_usd, and ` +
              `deadline_ms (set on the item or on the parent call)`,
            path: ["tasks", i],
          });
        }
      }
      return;
    }
    if (
      data.objective === undefined ||
      data.capability_tag === undefined ||
      data.cost_ceiling_usd === undefined ||
      data.deadline_ms === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide objective, capability_tag, cost_ceiling_usd, and " +
          "deadline_ms — or a non-empty tasks array",
      });
    }
  });
export type TaskInput = z.infer<typeof TaskInputSchema>;

export type TaskResult = {
  status: "completed" | "failed" | "partial";
  content: ReadonlyArray<ContentBlock>;
  workerPeerId: string;
  workerRuntime: string;
  costUsd: number;
  durationMs: number;
  verdict: unknown;
  signature: string;
};

export interface MakeTaskToolOptions {
  submitter: MeshSubmitter;
  fanOutRegistry?: FanOutRegistry;
  onSubagentComplete?: (result: SubagentResult) => void;
  /**
   * Called when a background child settles (push notice for the parent).
   * Not used for foreground awaits.
   */
  onBackgroundSettle?: (info: {
    jobId: string;
    agentId: string;
    result: SubagentResult;
  }) => void;
  maxSubagents?: number;
  /** Concurrency for tasks[] / fan-out expands. Default 4. */
  maxParallel?: number;
  jobs?: import("../jobs/types.js").JobRegistry;
  backgroundMode?: import("./background.js").SubagentBackgroundMode;
}

export const VERDICT_IS_PREDICTION =
  "Treat the returned `verdict` as a PREDICTION about the work's quality " +
  "(synthesized from how the sub-agent stopped and what it produced), not as " +
  "evidence that the work succeeded. It is a fallible judgment, not an " +
  "observation of consequence. The causal evidence is the work's own output: " +
  "command output, test results, diffs, files. If the verdict and the " +
  "evidence disagree, believe the evidence, and verify external state " +
  "yourself before relying on the result.";

function resolveInputs(args: TaskInput): SubagentInput[] | { error: string } {
  const peer =
    args.preferred_peer_id !== undefined
      ? { preferredPeerId: args.preferred_peer_id }
      : {};
  const runtime =
    args.preferred_runtime !== undefined
      ? { preferredRuntime: args.preferred_runtime as never }
      : {};

  if (args.tasks !== undefined && args.tasks.length > 0) {
    const out: SubagentInput[] = [];
    for (const t of args.tasks) {
      const tag = t.capability_tag ?? args.capability_tag;
      const cost = t.cost_ceiling_usd ?? args.cost_ceiling_usd;
      const deadline = t.deadline_ms ?? args.deadline_ms;
      if (tag === undefined || cost === undefined || deadline === undefined) {
        return {
          error:
            "tasks items need capability_tag, cost_ceiling_usd, and deadline_ms",
        };
      }
      out.push({
        objective: t.objective,
        capabilityTag: tag,
        costCeilingUsd: cost,
        deadlineMs: deadline,
        ...peer,
        ...runtime,
      });
    }
    return out;
  }

  if (
    args.objective === undefined ||
    args.capability_tag === undefined ||
    args.cost_ceiling_usd === undefined ||
    args.deadline_ms === undefined
  ) {
    return {
      error:
        "objective, capability_tag, cost_ceiling_usd, and deadline_ms are required",
    };
  }
  return [
    {
      objective: args.objective,
      capabilityTag: args.capability_tag,
      costCeilingUsd: args.cost_ceiling_usd,
      deadlineMs: args.deadline_ms,
      ...peer,
      ...runtime,
    },
  ];
}

function failedResult(text: string, reason: string): SubagentResult {
  return {
    status: "failed",
    content: [{ type: "text", text }],
    workerPeerId: "",
    workerRuntime: "envoy-harness",
    costUsd: 0,
    durationMs: 0,
    verdict: { kind: "fail", reason, rollback: false },
    signature: "",
  };
}

/** When abort skips some children, surface requested vs completed to the model. */
function markPartialAbort(
  result: SubagentResult,
  completed: number,
  requested: number,
): SubagentResult {
  const note: ContentBlock = {
    type: "text",
    text:
      `[aborted] completed ${completed}/${requested} sub-agents before abort. ` +
      `Treat this as incomplete — do not assume the missing children ran.\n`,
  };
  return {
    ...result,
    // Incomplete batch is always "partial" so the model cannot treat
    // an aborted fan-out as a full success/failure of the whole set.
    status: "partial",
    content: [note, ...result.content],
  };
}

export function makeTaskTool(
  submitterOrOptions: MeshSubmitter | MakeTaskToolOptions,
): Tool {
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
  const onBackgroundSettle =
    "submit" in submitterOrOptions
      ? undefined
      : submitterOrOptions.onBackgroundSettle;
  const maxSubagents: number | undefined =
    "submit" in submitterOrOptions
      ? undefined
      : submitterOrOptions.maxSubagents;
  const maxParallel =
    "submit" in submitterOrOptions
      ? DEFAULT_MAX_PARALLEL_TOOL_CALLS
      : (submitterOrOptions.maxParallel ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS);
  const backgroundJobs =
    "submit" in submitterOrOptions ? undefined : submitterOrOptions.jobs;
  const backgroundMode =
    "submit" in submitterOrOptions
      ? undefined
      : submitterOrOptions.backgroundMode;

  return {
    name: "task",
    description:
      "Spawn one or more sub-agents in NEW sessions (own permission state " +
      "and transcript); they may run on this node or a peer in the mesh. " +
      "For independent work, either emit several task calls in one " +
      "assistant message or pass a tasks array in one call. Foreground " +
      "awaits results; set run_in_background: true to keep working and " +
      "join later with wait_agents / job_wait (settlement notices also " +
      "arrive in-session). " +
      VERDICT_IS_PREDICTION,
    parameters: TaskInputSchema,
    async execute(args, ctx) {
      if (args.background_mode !== undefined && args.run_in_background !== true) {
        return {
          content:
            "background_mode has no effect without run_in_background: true. Set run_in_background, or drop background_mode.",
          isError: true,
        };
      }

      const resolved = resolveInputs(args);
      if ("error" in resolved) {
        return { content: resolved.error, isError: true };
      }
      const inputs = resolved;

      if (maxSubagents !== undefined && inputs.length > maxSubagents) {
        return {
          content: `maxSubagents reached: ${inputs.length} sub-agents requested (cap is ${maxSubagents}). Refused.`,
          isError: true,
        };
      }

      // ---- background path -------------------------------------------
      if (args.run_in_background === true) {
        if (backgroundJobs === undefined) {
          return {
            content:
              "run_in_background is unavailable: this host did not wire a background job registry.",
            isError: true,
          };
        }
        if (!supportsContinuable(submitter)) {
          return {
            content:
              "run_in_background is unavailable: the configured sub-agent submitter cannot run continuable children.",
            isError: true,
          };
        }
        for (const input of inputs) {
          if (fanOutRegistry?.lookup(input.capabilityTag) !== undefined) {
            return {
              content:
                "run_in_background cannot be combined with a fan-out capability tag: fan-out aggregates N children into one result, which a background job id cannot represent. Run it in the foreground, or use a tag without a fan-out spec.",
              isError: true,
            };
          }
        }
        try {
          const mode = args.background_mode ?? backgroundMode ?? "one-shot";
          const batch: Array<{
            job_id: string;
            agent_id: string;
            status: string;
          }> = [];
          for (const input of inputs) {
            const ids: { jobId: string; agentId: string } = {
              jobId: "",
              agentId: "",
            };
            const s = spawnBackgroundSubagent({
              submitter,
              jobs: backgroundJobs,
              input,
              owner: ctx.session.id,
              mode,
              ...(onSubagentComplete !== undefined
                ? { onResult: onSubagentComplete }
                : {}),
              ...(onBackgroundSettle !== undefined
                ? {
                    onSettle: (result) => {
                      onBackgroundSettle({
                        jobId: ids.jobId,
                        agentId: ids.agentId,
                        result,
                      });
                    },
                  }
                : {}),
            });
            ids.jobId = s.jobId;
            ids.agentId = s.agentId;
            batch.push({
              job_id: s.jobId,
              agent_id: s.agentId,
              status: s.status,
            });
          }
          return {
            content: JSON.stringify({
              ...(batch.length === 1
                ? {
                    job_id: batch[0]!.job_id,
                    agent_id: batch[0]!.agent_id,
                    status: batch[0]!.status,
                  }
                : { jobs: batch }),
              mode,
              hint: "wait_agents / job_status / job_output / job_wait observe; job_kill cancels; list_agents finds them later.",
            }),
          };
        } catch (err) {
          return {
            content: `failed to start background sub-agent: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }
      // ---- end background path ---------------------------------------

      // Single input + fan-out registry
      if (inputs.length === 1) {
        const baseInput = inputs[0]!;
        const spec = fanOutRegistry?.lookup(baseInput.capabilityTag);
        let result: SubagentResult;
        if (spec) {
          if (spec.count < 1) {
            result = failedResult(
              `FanOutSpec for "${spec.capabilityTag}" has invalid count ${spec.count}; must be >= 1.`,
              "invalid FanOutSpec count",
            );
          } else if (
            maxSubagents !== undefined &&
            spec.count > maxSubagents
          ) {
            result = failedResult(
              `maxSubagents reached: FanOutSpec for "${spec.capabilityTag}" expands to ${spec.count} sub-agents (cap is ${maxSubagents}). Refused.`,
              "maxSubagents exceeded by FanOutSpec",
            );
          } else {
            const partition = spec.partition ?? ((input) => input);
            const fanInputs: SubagentInput[] = [];
            for (let i = 0; i < spec.count; i++) {
              fanInputs.push(partition(baseInput, i, spec.count));
            }
            const results = await mapBoundedParallel(
              fanInputs,
              maxParallel,
              ctx.abortSignal,
              (input) => submitter.submit(input, ctx.abortSignal),
            );
            if (results.length === 0) {
              return {
                content:
                  "aborted: no fan-out sub-agents completed before abort",
                isError: true,
              };
            }
            result = aggregateFanOutResults(results);
            if (results.length < fanInputs.length) {
              result = markPartialAbort(
                result,
                results.length,
                fanInputs.length,
              );
            }
          }
        } else {
          result = await submitter.submit(baseInput, ctx.abortSignal);
        }
        if (onSubagentComplete) onSubagentComplete(result);
        return { content: result };
      }

      // Multi tasks[] foreground — bounded parallel, then aggregate
      const results = await mapBoundedParallel(
        inputs,
        maxParallel,
        ctx.abortSignal,
        (input) => submitter.submit(input, ctx.abortSignal),
      );
      if (results.length === 0) {
        return {
          content: "aborted: no sub-agents completed before abort",
          isError: true,
        };
      }
      let result = aggregateFanOutResults(results);
      if (results.length < inputs.length) {
        result = markPartialAbort(result, results.length, inputs.length);
      }
      if (onSubagentComplete) onSubagentComplete(result);
      return { content: result };
    },
  };
}
