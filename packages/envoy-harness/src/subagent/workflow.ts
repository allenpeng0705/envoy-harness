/**
 * R4.17 — explicit workflow orchestration over {@link MeshSubmitter}.
 *
 * Complements F10.4 opaque capability fan-out and R4.8 Team DAGs with
 * host/model-facing `parallel(tasks)` and `pipeline(steps)`.
 */

import type { ContentBlock } from "../tools/types.js";
import { aggregateFanOutResults } from "./fan-out.js";
import type { MeshSubmitter, SubagentInput, SubagentResult } from "./types.js";

/** One unit of work for {@link parallel} / {@link pipeline}. */
export type WorkflowTask = SubagentInput;

export interface WorkflowRunOptions {
  /** Abort for all in-flight / remaining submits. */
  signal?: AbortSignal;
  /**
   * Cap on concurrent tasks in {@link parallel}. Default: no cap
   * beyond `tasks.length`. When set and `tasks.length` exceeds it,
   * throws (refuse-all, same teaching signal as F10.2 maxSubagents).
   */
  maxSubagents?: number;
  /** Fired after each pipeline step (and each parallel settle). */
  onTaskComplete?: (
    result: SubagentResult,
    index: number,
    task: WorkflowTask,
  ) => void;
}

export interface WorkflowParallelResult {
  /** Per-task results in input order. */
  results: ReadonlyArray<SubagentResult>;
  /** Aggregated view (same rules as F10.4 `aggregateFanOutResults`). */
  aggregated: SubagentResult;
}

/**
 * Run tasks concurrently via `Promise.all`.
 * Optional `preferredPeerId` on each task routes when a peer
 * submitter is configured (Package 1 tests stay local-only).
 */
export async function parallel(
  submitter: MeshSubmitter,
  tasks: ReadonlyArray<WorkflowTask>,
  options: WorkflowRunOptions = {},
): Promise<WorkflowParallelResult> {
  if (tasks.length === 0) {
    throw new Error("workflow.parallel: tasks must be non-empty");
  }
  if (
    options.maxSubagents !== undefined &&
    tasks.length > options.maxSubagents
  ) {
    throw new Error(
      `workflow.parallel: ${tasks.length} tasks exceed maxSubagents=${options.maxSubagents}`,
    );
  }
  const signal = options.signal ?? new AbortController().signal;
  const results = await Promise.all(
    tasks.map(async (task, index) => {
      const result = await submitter.submit(task, signal);
      options.onTaskComplete?.(result, index, task);
      return result;
    }),
  );
  return {
    results,
    aggregated: aggregateFanOutResults(results),
  };
}

function textFromResult(result: SubagentResult): string {
  const parts: string[] = [];
  for (const b of result.content as ReadonlyArray<ContentBlock>) {
    if (b.type === "text") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

/**
 * Run steps sequentially. Each step after the first receives prior
 * step text appended under "Context from previous step:".
 * Stops early if a step fails (`status === "failed"`).
 */
export async function pipeline(
  submitter: MeshSubmitter,
  steps: ReadonlyArray<WorkflowTask>,
  options: WorkflowRunOptions = {},
): Promise<{
  results: ReadonlyArray<SubagentResult>;
  final: SubagentResult;
}> {
  if (steps.length === 0) {
    throw new Error("workflow.pipeline: steps must be non-empty");
  }
  const signal = options.signal ?? new AbortController().signal;
  const results: SubagentResult[] = [];
  let priorText = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const objective =
      priorText.length > 0
        ? `${step.objective}\n\nContext from previous step:\n${priorText}`
        : step.objective;
    const input: SubagentInput = { ...step, objective };
    const result = await submitter.submit(input, signal);
    results.push(result);
    options.onTaskComplete?.(result, i, step);
    if (result.status === "failed") {
      return { results, final: result };
    }
    priorText = textFromResult(result) || priorText;
  }
  return { results, final: results[results.length - 1]! };
}
