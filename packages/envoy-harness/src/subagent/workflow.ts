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
  /**
   * Wave 3 — shared work units across children. Each admitted child
   * consumes 1; when exhausted, remaining children are skipped.
   */
  workBudget?: number;
  /**
   * Wave 3 — shared token budget across children. Consumes
   * `result.usage` input+output when present; stops admitting when exhausted.
   */
  tokenBudget?: number;
  /** Fired after each pipeline step (and each parallel settle). */
  onTaskComplete?: (
    result: SubagentResult,
    index: number,
    task: WorkflowTask,
  ) => void;
}

function usageTokens(result: SubagentResult): number {
  const u = (result as { usage?: { inputTokens?: number; outputTokens?: number } })
    .usage;
  if (u === undefined) return 0;
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
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
): Promise<WorkflowParallelResult & { budgetExhausted?: boolean }> {
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
  let workLeft = options.workBudget;
  let tokensLeft = options.tokenBudget;
  let budgetExhausted = false;
  const results: SubagentResult[] = [];
  // Admit sequentially against budgets, then run admitted set concurrently.
  const admitted: Array<{ task: WorkflowTask; index: number }> = [];
  for (let i = 0; i < tasks.length; i++) {
    if (workLeft !== undefined && workLeft <= 0) {
      budgetExhausted = true;
      break;
    }
    if (tokensLeft !== undefined && tokensLeft <= 0) {
      budgetExhausted = true;
      break;
    }
    if (workLeft !== undefined) workLeft -= 1;
    admitted.push({ task: tasks[i]!, index: i });
  }
  const settled = await Promise.all(
    admitted.map(async ({ task, index }) => {
      const result = await submitter.submit(task, signal);
      if (tokensLeft !== undefined) {
        tokensLeft -= usageTokens(result);
        if (tokensLeft <= 0) budgetExhausted = true;
      }
      options.onTaskComplete?.(result, index, task);
      return { index, result };
    }),
  );
  settled.sort((a, b) => a.index - b.index);
  for (const s of settled) results.push(s.result);
  return {
    results,
    aggregated: aggregateFanOutResults(results),
    ...(budgetExhausted ? { budgetExhausted: true } : {}),
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
  budgetExhausted?: boolean;
}> {
  if (steps.length === 0) {
    throw new Error("workflow.pipeline: steps must be non-empty");
  }
  const signal = options.signal ?? new AbortController().signal;
  const results: SubagentResult[] = [];
  let priorText = "";
  let workLeft = options.workBudget;
  let tokensLeft = options.tokenBudget;
  let budgetExhausted = false;

  for (let i = 0; i < steps.length; i++) {
    if (workLeft !== undefined && workLeft <= 0) {
      budgetExhausted = true;
      break;
    }
    if (tokensLeft !== undefined && tokensLeft <= 0) {
      budgetExhausted = true;
      break;
    }
    if (workLeft !== undefined) workLeft -= 1;
    const step = steps[i]!;
    const objective =
      priorText.length > 0
        ? `${step.objective}\n\nContext from previous step:\n${priorText}`
        : step.objective;
    const input: SubagentInput = { ...step, objective };
    const result = await submitter.submit(input, signal);
    if (tokensLeft !== undefined) {
      tokensLeft -= usageTokens(result);
    }
    results.push(result);
    options.onTaskComplete?.(result, i, step);
    if (result.status === "failed") {
      return {
        results,
        final: result,
        ...(budgetExhausted ? { budgetExhausted: true } : {}),
      };
    }
    priorText = textFromResult(result) || priorText;
  }
  return {
    results,
    final: results[results.length - 1]!,
    ...(budgetExhausted ? { budgetExhausted: true } : {}),
  };
}
