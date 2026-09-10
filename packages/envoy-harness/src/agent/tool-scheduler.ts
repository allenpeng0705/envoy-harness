/**
 * Bounded, **model-order** tool-call scheduling.
 *
 * Extracted from `tool-executor.ts` (which hit the 800-line CI hard cap)
 * because it is a self-contained concern: how a batch of tool calls is
 * executed concurrently and how their results reach the transcript.
 *
 * **The two properties this module exists to guarantee:**
 *
 * 1. **Determinism.** Each call used to append its own `tool_result` at
 *    completion time, so a parallel batch produced a transcript in
 *    completion order — different across runs for identical input.
 *    Anything that replays, diffs, or asserts on a transcript (session
 *    resume, prompt-prefix comparison, tests) then became flaky.
 *    Results now commit in **model order**, regardless of settle order.
 *
 * 2. **Bounded concurrency.** A count cap ("refuse the batch past N
 *    calls") is not a concurrency limit. Firing N sub-agents at once is
 *    N concurrent model conversations; the rolling pool bounds that
 *    independently of the count cap.
 *
 * Abort is handled by the caller's `runOne`: a call that never started
 * is recorded as never started, so the log still pairs every `tool_call`
 * with a `tool_result` and stays replayable.
 */

/** Default tool-call concurrency for a parallel batch. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 4;

/**
 * Where a finished tool result goes.
 *
 * The executor calls this instead of appending directly, so a parallel
 * batch can finish out of order and still be committed in model order.
 */
export type ToolResultSink = (
  toolCallId: string,
  content: unknown,
  isError: boolean,
) => void;

/** One committed result, captured by the sink during execution. */
export interface PendingToolResult {
  readonly id: string;
  readonly content: unknown;
  readonly isError: boolean;
}

export interface ToolGroupRunOptions<T> {
  /** Append one result to the transcript (always called in model order). */
  readonly commit: (result: PendingToolResult) => void;
  /** The calls to run, in model order. */
  readonly calls: ReadonlyArray<T>;
  /** Concurrency cap; clamped to at least 1. */
  readonly maxParallel: number;
  /** Abort signal. Once aborted, no further calls are started. */
  readonly signal: AbortSignal;
  /**
   * Execute ONE call, reporting its results through `sink` rather than
   * appending them. Must resolve once the call is fully finished.
   */
  readonly runOne: (call: T, sink: ToolResultSink) => Promise<void>;
  /** Called for a call that never started (aborted before dispatch). */
  readonly onSkipped: (call: T) => void;
}

/**
 * Run a group of tool calls with a bounded rolling pool, committing
 * every result in model order.
 *
 * `runOne` may be called concurrently; the caller is responsible for
 * thread-safety of whatever it captures.
 */
export async function runToolGroupInModelOrder<T>(
  options: ToolGroupRunOptions<T>,
): Promise<void> {
  const { calls, signal, runOne, onSkipped, commit } = options;
  if (calls.length === 0) return;
  const maxParallel = Math.max(1, Math.floor(options.maxParallel));

  const slots: Array<PendingToolResult[] | undefined> = new Array(calls.length);
  const inFlight = new Set<Promise<void>>();
  let next = 0;

  const start = (index: number): void => {
    const call = calls[index]!;
    const collected: PendingToolResult[] = [];
    const task: Promise<void> = runOne(call, (id, content, isError) => {
      collected.push({ id, content, isError });
    })
      .then(() => {
        slots[index] = collected;
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  };

  while (next < calls.length || inFlight.size > 0) {
    while (next < calls.length && inFlight.size < maxParallel && !signal.aborted) {
      start(next);
      next += 1;
    }
    if (inFlight.size === 0) break;
    // Wait for ONE slot to free up, then refill — not for a barrier.
    await Promise.race(inFlight);
  }
  // Drain anything still running (e.g. after an abort mid-flight).
  await Promise.all(inFlight);

  for (let i = 0; i < calls.length; i += 1) {
    const collected = slots[i];
    if (collected === undefined || collected.length === 0) {
      onSkipped(calls[i]!);
      continue;
    }
    for (const entry of collected) {
      // Commit here, in index order, which is the whole point: the
      // transcript order is model order, not settle order.
      commit(entry);
    }
  }
}
