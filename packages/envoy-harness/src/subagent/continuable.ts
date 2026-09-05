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
   * When true (default for blocking `submit()`), settle as soon as
   * the inbox is empty after a run. When false, stay open until
   * `close()` / `interrupt()` / deadline.
   */
  autoSettleAfterIdle?: boolean;
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
  autoSettleAfterIdle: boolean;
  closed: boolean;
  startedAt: number;
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  parentAbortListener: (() => void) | undefined;
  parentSignal: AbortSignal | undefined;
  runChain: Promise<void>;
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
      autoSettleAfterIdle: options.autoSettleAfterIdle !== false,
      closed: false,
      startedAt: Date.now(),
      deadlineTimer: undefined,
      parentAbortListener: undefined,
      parentSignal: options.parentSignal,
      runChain: Promise.resolve(),
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
          last = synthesizeFromAgentResult(
            agentResult,
            this.opts.workerPeerId,
            running.startedAt,
            this.opts.signer,
          );
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
        cleanup();
        const idx = running.settleWaiters.indexOf(waiter);
        if (idx >= 0) running.settleWaiters.splice(idx, 1);
        reject(new Error("waitSettle aborted"));
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
