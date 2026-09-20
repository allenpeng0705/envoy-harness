/**
 * R4.9a — Continuable local sub-agent handle.
 *
 * dsh/Codex pattern: spawn a sub-agent that can receive follow-up
 * inbox messages (`send`), be aborted (`interrupt`), and settle
 * (`waitSettle`) without blocking the parent on the initial spawn.
 */

import type { Agent } from "../agent.js";
import type { ContentBlock } from "../tools/types.js";
import type { Verdict } from "../verifier/types.js";
import type {
  SubagentInput,
  SubagentRecord,
  SubagentResult,
} from "./types.js";
import type { SubagentResultSigner } from "./signer.js";

export type SubagentHandleId = string;

export interface ContinuableSubagentHandle {
  readonly id: SubagentHandleId;
  readonly sessionId: string;
  /** Enqueue a follow-up message (runs after the current turn, if any). */
  send(message: string | ReadonlyArray<ContentBlock>): Promise<void>;
  /** Abort the in-flight run (idempotent). Settles as failed. */
  interrupt(reason?: string): void;
  /**
   * Mark no further inbox messages; settle after the current run
   * drains. Idempotent.
   */
  close(): void;
  /**
   * The child's output so far: completed turns, plus the **in-flight
   * turn's text as it streams**. Updated on every assistant delta, so a
   * poller sees progress within a turn rather than only after it.
   *
   * Bounded — it keeps a tail, not the whole history.
   */
  output(): string;
  /** Await the final {@link SubagentResult}. */
  waitSettle(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<SubagentResult>;
  /** Lifecycle snapshot. */
  status(): SubagentRecord;
}

export interface SubmitContinuableOptions {
  /** Parent abort — also interrupts this handle. */
  parentSignal?: AbortSignal;
  /** Fired once when the handle settles. */
  onSettle?: (result: SubagentResult, record: SubagentRecord) => void;
  /**
   * Fired after every completed turn of a continuable child — i.e. once
   * per `send()`ed message, not just once at settle. This is what makes a
   * background child's output observable while it is still alive (a
   * one-shot foreground `submit()` never needs it).
   *
   * Exceptions are swallowed: a host callback must not break the child.
   */
  onTurn?: (result: SubagentResult, record: SubagentRecord) => void;
  /**
   * When true (default for blocking `submit()`), settle as soon as
   * the inbox is empty after a run. When false, stay open until
   * `close()` / `interrupt()` / deadline.
   */
  autoSettleAfterIdle?: boolean;
}

/**
 * The capability a {@link MeshSubmitter} exposes when it can run
 * **continuable** (background, steerable) children rather than only
 * blocking ones. Detected structurally — a submitter that does not
 * implement it simply cannot serve `task { run_in_background: true }`.
 */
export interface ContinuableSubmitter {
  submitContinuable(
    input: SubagentInput,
    options?: SubmitContinuableOptions,
  ): ContinuableSubagentHandle;
  getHandle(id: SubagentHandleId): ContinuableSubagentHandle | undefined;
}

export interface ContinuableRuntimeOptions {
  buildSubagent: (input: SubagentInput) => Agent;
  workerPeerId: string;
  signer?: SubagentResultSigner;
  /** Push into the submitter's `/agents` list. */
  records: SubagentRecord[];
}

interface SettleWaiter {
  resolve: (result: SubagentResult) => void;
  reject: (err: unknown) => void;
}

interface WorkWaiter {
  resolve: () => void;
}

interface RunningSubagent {
  id: SubagentHandleId;
  agent: Agent;
  input: SubagentInput;
  record: SubagentRecord;
  inbox: Array<string | ReadonlyArray<ContentBlock>>;
  abortController: AbortController;
  settleWaiters: SettleWaiter[];
  workWaiters: WorkWaiter[];
  settled: boolean;
  result: SubagentResult | undefined;
  onSettle: ((result: SubagentResult, record: SubagentRecord) => void) | undefined;
  onTurn: ((result: SubagentResult, record: SubagentRecord) => void) | undefined;
  autoSettleAfterIdle: boolean;
  closed: boolean;
  startedAt: number;
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  parentAbortListener: (() => void) | undefined;
  parentSignal: AbortSignal | undefined;
  runChain: Promise<void>;
  /** Authoritative text of each completed turn (bounded tail). */
  turnSegments: string[];
  /** The in-flight turn's streamed text. Cleared when the turn commits. */
  liveText: string;
}

/** Cap on one turn's streamed tail. */
const MAX_LIVE_CHARS = 16_384;
/** Cap on the retained completed-turn text. */
const MAX_TURN_CHARS = 65_536;
/** Marks a gap where the bounded tail dropped earlier output. */
const TRUNCATION_MARKER = "…[earlier output truncated]\n";

function appendLive(running: RunningSubagent, delta: string): void {
  running.liveText += delta;
  // Trim lazily (only once it has doubled) so a long turn is amortized
  // O(1) per delta rather than a copy per delta. The marker matters: a
  // silent gap in a child's output is worse than a visible one.
  if (running.liveText.length > MAX_LIVE_CHARS * 2) {
    running.liveText =
      TRUNCATION_MARKER + running.liveText.slice(-MAX_LIVE_CHARS);
  }
}

/**
 * Commit a finished turn's authoritative text and drop the streamed version
 * of it, so a turn is never present twice. When the authoritative text is
 * empty but the turn streamed something (a truncated or tool-only turn), the
 * streamed text is kept — discarding it would throw away the only record of
 * what the child said.
 */
function commitTurn(running: RunningSubagent, text: string): void {
  const authoritative = text.trim();
  const streamed = running.liveText.trim();
  running.liveText = "";
  const committed = authoritative.length > 0 ? authoritative : streamed;
  if (committed.length === 0) return;
  running.turnSegments.push(committed);
  let total = running.turnSegments.reduce((n, s) => n + s.length + 2, 0);
  while (total > MAX_TURN_CHARS && running.turnSegments.length > 1) {
    total -= (running.turnSegments.shift() ?? "").length + 2;
  }
}

function outputOf(running: RunningSubagent): string {
  const parts = [...running.turnSegments];
  if (running.liveText.length > 0) parts.push(running.liveText);
  return parts.join("\n\n");
}

/** Concatenate a result's text blocks. */
function textOf(result: SubagentResult): string {
  return result.content
    .filter(
      (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

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

function synthesizeFromAgentResult(
  result: import("../agent.js").AgentResult,
  workerPeerId: string,
  startedAt: number,
  signer: SubagentResultSigner | undefined,
): SubagentResult {
  const verdict = synthesizeVerdict(result);
  const status: SubagentResult["status"] =
    result.stopReason === "end_turn" || result.stopReason === "tool_use"
      ? "completed"
      : result.stopReason === "aborted" ||
          result.stopReason === "max_iterations"
        ? "failed"
        : "partial";
  const base: SubagentResult = {
    status,
    content: result.content,
    workerPeerId,
    workerRuntime: "envoy-harness",
    costUsd: result.metrics.costUsd,
    durationMs: Date.now() - startedAt,
    verdict,
    signature: "",
  };
  if (signer) {
    base.signature = signer(base);
  }
  return base;
}

function failedResult(
  message: string,
  workerPeerId: string,
  startedAt: number,
  signer: SubagentResultSigner | undefined,
  reason: string,
): SubagentResult {
  const base: SubagentResult = {
    status: "failed",
    content: [{ type: "text", text: message }],
    workerPeerId,
    workerRuntime: "envoy-harness",
    costUsd: 0,
    durationMs: Date.now() - startedAt,
    verdict: { kind: "fail", reason, rollback: false },
    signature: "",
  };
  if (signer) {
    base.signature = signer(base);
  }
  return base;
}

/**
 * Registry of continuable local sub-agents for one {@link LocalMeshSubmitter}.
 */
export class ContinuableSubagentRegistry {
  private readonly handles = new Map<SubagentHandleId, RunningSubagent>();
  private readonly opts: ContinuableRuntimeOptions;

  constructor(opts: ContinuableRuntimeOptions) {
    this.opts = opts;
  }

  submitContinuable(
    input: SubagentInput,
    options: SubmitContinuableOptions = {},
  ): ContinuableSubagentHandle {
    const agent = this.opts.buildSubagent(input);
    const sessionId = agent.getSessionId();
    const id = sessionId;
    const record: SubagentRecord = {
      sessionId,
      capabilityTag: input.capabilityTag,
      objective: input.objective,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.opts.records.push(record);

    const abortController = new AbortController();
    const running: RunningSubagent = {
      id,
      agent,
      input,
      record,
      inbox: [input.objective],
      abortController,
      settleWaiters: [],
      workWaiters: [],
      settled: false,
      result: undefined,
      onSettle: options.onSettle,
      onTurn: options.onTurn,
      autoSettleAfterIdle: options.autoSettleAfterIdle !== false,
      closed: false,
      startedAt: Date.now(),
      deadlineTimer: undefined,
      parentAbortListener: undefined,
      parentSignal: options.parentSignal,
      runChain: Promise.resolve(),
      turnSegments: [],
      liveText: "",
    };

    // Stream the child's assistant deltas into its output buffer so a
    // poller (`handle.output()` / `job_output`) sees progress *within* a
    // turn, not only once the turn ends. Chained, not replaced: a host
    // factory that installed its own sink keeps working.
    const priorSink = agent.assistantStreamSink;
    agent.assistantStreamSink = (delta: string): void => {
      // A settled child is done: an interrupt (or deadline, or parent abort)
      // can settle it while the model call is still streaming, and a delta
      // arriving after that would rewrite output the job already reported.
      // Dropped for the host sink too — the turn it belongs to was cancelled.
      if (running.settled) return;
      if (priorSink !== undefined) {
        try {
          priorSink(delta);
        } catch {
          // A host sink must not break the child.
        }
      }
      appendLive(running, delta);
    };

    running.deadlineTimer = setTimeout(() => {
      this.interruptHandle(
        running,
        `sub-agent deadline exceeded (${input.deadlineMs}ms)`,
      );
    }, input.deadlineMs);

    const parentSignal = options.parentSignal;
    if (parentSignal !== undefined) {
      const onParentAbort = (): void => {
        this.interruptHandle(
          running,
          typeof parentSignal.reason === "string"
            ? parentSignal.reason
            : "parent aborted",
        );
      };
      running.parentAbortListener = onParentAbort;
      if (parentSignal.aborted) {
        onParentAbort();
      } else {
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
      }
    }

    this.handles.set(id, running);
    running.runChain = this.pump(running);

    return this.wrapHandle(running);
  }

  getHandle(id: SubagentHandleId): ContinuableSubagentHandle | undefined {
    const running = this.handles.get(id);
    return running === undefined ? undefined : this.wrapHandle(running);
  }

  private wrapHandle(running: RunningSubagent): ContinuableSubagentHandle {
    return {
      id: running.id,
      sessionId: running.record.sessionId,
      send: async (message) => {
        if (running.settled) {
          throw new Error(`sub-agent ${running.id} already settled`);
        }
        running.inbox.push(message);
        this.wake(running);
      },
      interrupt: (reason) => {
        this.interruptHandle(running, reason ?? "interrupted");
      },
      close: () => {
        if (running.settled) return;
        running.closed = true;
        this.wake(running);
      },
      output: () => outputOf(running),
      waitSettle: (opts) => this.waitSettle(running, opts),
      status: () => ({ ...running.record }),
    };
  }

  private wake(running: RunningSubagent): void {
    for (const w of running.workWaiters.splice(0)) {
      w.resolve();
    }
  }

  private interruptHandle(running: RunningSubagent, reason: string): void {
    if (running.settled) return;
    running.closed = true;
    running.inbox.length = 0;
    running.agent.abort(reason);
    running.abortController.abort(reason);
    this.wake(running);
    // Settle immediately so waitSettle resolves even when the
    // agent is blocked inside a hung model.complete() that does
    // not observe the abort signal.
    this.settle(
      running,
      failedResult(
        `sub-agent interrupted: ${reason}`,
        this.opts.workerPeerId,
        running.startedAt,
        this.opts.signer,
        "interrupted",
      ),
    );
  }

  private async pump(running: RunningSubagent): Promise<void> {
    let last: SubagentResult | undefined;
    try {
      while (!running.settled) {
        const next = running.inbox.shift();
        if (next === undefined) {
          if (running.closed || running.autoSettleAfterIdle) {
            this.settle(
              running,
              last ??
                failedResult(
                  "sub-agent settled with no result",
                  this.opts.workerPeerId,
                  running.startedAt,
                  this.opts.signer,
                  "empty",
                ),
            );
            return;
          }
          await new Promise<void>((resolve) => {
            running.workWaiters.push({ resolve });
          });
          continue;
        }
        if (running.abortController.signal.aborted) {
          this.settle(
            running,
            failedResult(
              `sub-agent interrupted: ${String(running.abortController.signal.reason ?? "aborted")}`,
              this.opts.workerPeerId,
              running.startedAt,
              this.opts.signer,
              "interrupted",
            ),
          );
          return;
        }
        try {
          const agentResult = await running.agent.run(next);
          // The child may have settled *while this turn was running* (an
          // interrupt, a deadline, a parent abort). Everything below mutates
          // the record, the output buffer and fires `onTurn`, so doing it
          // after settlement would change state behind a job that already
          // reported a terminal status — and the late result is discarded
          // anyway. Stop here.
          if (running.settled) return;
          last = synthesizeFromAgentResult(
            agentResult,
            this.opts.workerPeerId,
            running.startedAt,
            this.opts.signer,
          );
          running.record.costUsd = last.costUsd;
          running.record.durationMs = last.durationMs;
          // The turn is over: keep its authoritative text and discard the
          // streamed copy, so the turn is not present twice.
          commitTurn(running, textOf(last));
          try {
            running.onTurn?.(last, running.record);
          } catch {
            // Host callbacks must not break the child.
          }
          if (agentResult.stopReason === "aborted") {
            this.settle(running, last);
            return;
          }
        } catch (err) {
          this.settle(
            running,
            failedResult(
              `sub-agent failed: ${(err as Error).message}`,
              this.opts.workerPeerId,
              running.startedAt,
              this.opts.signer,
              "sub-agent threw",
            ),
          );
          return;
        }
      }
    } finally {
      // no-op; settle cleans up
    }
  }

  private settle(running: RunningSubagent, result: SubagentResult): void {
    if (running.settled) return;
    running.settled = true;
    running.result = result;
    // Drop the live entry. The `record` (in the submitter's list) is what a
    // UI reads for history; the handle is only useful while the child can be
    // steered, and keeping every settled child here retained its Agent,
    // transcript and output buffer for the life of the process. A caller
    // that already holds a handle keeps working — the closures reference
    // `running` directly — but `getHandle(id)` now reports "gone", which is
    // also what makes the `steerable` flag honest.
    this.handles.delete(running.id);
    // Interrupted before any turn produced text: keep the failure message as
    // the child's output so a poller is not left looking at an empty string.
    if (running.turnSegments.length === 0 && running.liveText.length === 0) {
      commitTurn(running, textOf(result));
    }
    running.record.status = result.status;
    running.record.costUsd = result.costUsd;
    running.record.durationMs = result.durationMs;
    running.record.completedAt = new Date().toISOString();
    if (running.deadlineTimer !== undefined) {
      clearTimeout(running.deadlineTimer);
      running.deadlineTimer = undefined;
    }
    if (
      running.parentSignal !== undefined &&
      running.parentAbortListener !== undefined
    ) {
      running.parentSignal.removeEventListener(
        "abort",
        running.parentAbortListener,
      );
    }
    for (const w of running.settleWaiters.splice(0)) {
      w.resolve(result);
    }
    for (const w of running.workWaiters.splice(0)) {
      w.resolve();
    }
    try {
      running.onSettle?.(result, running.record);
    } catch {
      // Host callbacks must not break settlement.
    }
  }

  private waitSettle(
    running: RunningSubagent,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SubagentResult> {
    if (running.settled && running.result !== undefined) {
      return Promise.resolve(running.result);
    }
    return new Promise<SubagentResult>((resolve, reject) => {
      const waiter: SettleWaiter = { resolve, reject };
      running.settleWaiters.push(waiter);

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        // Parent abort settles via interruptHandle → settle().
        // Do not reject here (race with that path); just drop the
        // waiter-cancel timeout/listener and let settle resolve.
        if (timeout !== undefined) clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", onAbort);
      };
      if (options?.signal !== undefined) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (options?.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cleanup();
          const idx = running.settleWaiters.indexOf(waiter);
          if (idx >= 0) running.settleWaiters.splice(idx, 1);
          reject(new Error(`waitSettle timed out (${options.timeoutMs}ms)`));
        }, options.timeoutMs);
      }
      const origResolve = waiter.resolve;
      waiter.resolve = (result) => {
        cleanup();
        origResolve(result);
      };
    });
  }
}
