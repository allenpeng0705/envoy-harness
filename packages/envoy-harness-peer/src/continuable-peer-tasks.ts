/**
 * R4.9b — server-side continuable peer task registry.
 */

import type { AgentAdapter, ExecuteInput } from "@envoymesh/agent-adapter";
import type { SignedAgentResult } from "@envoymesh/protocol";

import { combinePeerVerdicts } from "./scoreboard.js";
import type {
  PeerSubmitContinuableParams,
  PeerSubmitContinuableResult,
  PeerSubmitResponse,
  PeerTaskStatusResult,
  WireExecuteInput,
} from "./messages.js";

/** How long settled tasks stay queryable before GC. */
export const SETTLED_TASK_TTL_MS = 60_000;

interface RunningPeerTask {
  correlationId: string;
  sessionId: string;
  wire: WireExecuteInput;
  inbox: string[];
  abort: AbortController;
  closed: boolean;
  settled: boolean;
  autoSettleAfterIdle: boolean;
  status: PeerTaskStatusResult["status"];
  result: PeerSubmitResponse | undefined;
  startedAt: string;
  completedAt: string | undefined;
  workWaiters: Array<() => void>;
  settleWaiters: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
  }>;
  pump: Promise<void>;
  gcTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface PeerContinuableTaskRegistryOptions {
  adapter: AgentAdapter;
  peerId: string;
  verifyAfterExecute?: boolean;
  /** R4.10 — shared verify budget (optional). */
  verifyBudget?: import("@envoymesh/envoy-harness").VerifySessionBudget;
  /** Override settled-task retention (tests). Default 60s. */
  settledTtlMs?: number;
}

export class PeerContinuableTaskRegistry {
  private readonly tasks = new Map<string, RunningPeerTask>();
  private readonly opts: PeerContinuableTaskRegistryOptions;
  private readonly settledTtlMs: number;

  constructor(opts: PeerContinuableTaskRegistryOptions) {
    this.opts = opts;
    this.settledTtlMs = opts.settledTtlMs ?? SETTLED_TASK_TTL_MS;
  }

  /** Test / ops: number of retained tasks (including settled). */
  size(): number {
    return this.tasks.size;
  }

  start(params: PeerSubmitContinuableParams): PeerSubmitContinuableResult {
    const existing = this.tasks.get(params.correlationId);
    if (existing !== undefined) {
      return {
        correlationId: existing.correlationId,
        sessionId: existing.sessionId,
        status: existing.status,
        idempotent: true,
      };
    }
    const wire: WireExecuteInput = {
      ...params.input,
      correlationId: params.correlationId,
    };
    const abort = new AbortController();
    const task: RunningPeerTask = {
      correlationId: params.correlationId,
      sessionId: `peer-${params.correlationId.slice(0, 8)}`,
      wire,
      inbox: [wire.objective],
      abort,
      closed: false,
      settled: false,
      autoSettleAfterIdle: params.autoSettleAfterIdle === true,
      status: "running",
      result: undefined,
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      workWaiters: [],
      settleWaiters: [],
      pump: Promise.resolve(),
      gcTimer: undefined,
    };
    this.tasks.set(params.correlationId, task);
    task.pump = this.pump(task);
    return {
      correlationId: task.correlationId,
      sessionId: task.sessionId,
      status: "running",
    };
  }

  send(correlationId: string, message: string): void {
    const task = this.require(correlationId);
    if (task.settled) throw new Error(`task ${correlationId} already settled`);
    task.inbox.push(message);
    this.wake(task);
  }

  close(correlationId: string): void {
    const task = this.require(correlationId);
    if (task.settled) return;
    task.closed = true;
    this.wake(task);
  }

  interrupt(correlationId: string, reason?: string): void {
    const task = this.require(correlationId);
    if (task.settled) return;
    task.closed = true;
    task.inbox.length = 0;
    task.abort.abort(reason ?? "interrupted");
    this.wake(task);
  }

  status(correlationId: string): PeerTaskStatusResult {
    const task = this.require(correlationId);
    return this.snapshot(task);
  }

  /**
   * Block until the task settles or `timeoutMs` elapses.
   * Prefer this over client-side status polling.
   */
  async waitSettle(
    correlationId: string,
    timeoutMs: number,
  ): Promise<PeerTaskStatusResult> {
    const task = this.require(correlationId);
    if (task.settled) return this.snapshot(task);

    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      const entry = {
        resolve: () => finish(() => resolve()),
        reject: (err: unknown) => finish(() => reject(err)),
      };
      const timer = setTimeout(() => {
        const idx = task.settleWaiters.indexOf(entry);
        if (idx >= 0) task.settleWaiters.splice(idx, 1);
        finish(() =>
          reject(new Error(`waitSettle timed out after ${timeoutMs}ms`)),
        );
      }, timeoutMs);
      task.settleWaiters.push(entry);
      // Re-check in case settle raced with waiter registration.
      if (task.settled) {
        const idx = task.settleWaiters.indexOf(entry);
        if (idx >= 0) task.settleWaiters.splice(idx, 1);
        finish(() => resolve());
      }
    });
    // Use the local task ref — TTL 0 may have already deleted the map entry.
    return this.snapshot(task);
  }

  private snapshot(task: RunningPeerTask): PeerTaskStatusResult {
    return {
      correlationId: task.correlationId,
      sessionId: task.sessionId,
      status: task.status,
      settled: task.settled,
      objective: task.wire.objective,
      capabilityTag: task.wire.skillId,
      startedAt: task.startedAt,
      ...(task.completedAt !== undefined
        ? { completedAt: task.completedAt }
        : {}),
      ...(task.result !== undefined ? { result: task.result } : {}),
      ...(task.result !== undefined
        ? {
            costUsd: task.result.result.metrics.costUsd,
            durationMs: task.result.result.metrics.durationMs,
          }
        : {}),
    };
  }

  private require(correlationId: string): RunningPeerTask {
    const task = this.tasks.get(correlationId);
    if (task === undefined) {
      throw new Error(`unknown peer task: ${correlationId}`);
    }
    return task;
  }

  private wake(task: RunningPeerTask): void {
    for (const w of task.workWaiters.splice(0)) w();
  }

  private async pump(task: RunningPeerTask): Promise<void> {
    let last: PeerSubmitResponse | undefined;
    while (!task.settled) {
      const next = task.inbox.shift();
      if (next === undefined) {
        if (task.abort.signal.aborted) {
          this.settle(task, last, "failed");
          return;
        }
        if (task.closed || task.autoSettleAfterIdle) {
          this.settle(
            task,
            last,
            last !== undefined ? "completed" : "failed",
          );
          return;
        }
        await new Promise<void>((resolve) => {
          task.workWaiters.push(resolve);
        });
        continue;
      }
      if (task.abort.signal.aborted) {
        this.settle(task, last, "failed");
        return;
      }
      const input: ExecuteInput = {
        skillId: task.wire.skillId,
        objective: next,
        inputArtifacts:
          task.wire.inputArtifacts as ExecuteInput["inputArtifacts"],
        costCeilingUsd: task.wire.costCeilingUsd,
        deadlineMs: task.wire.deadlineMs,
        correlationId: task.correlationId,
        signal: task.abort.signal,
      };
      try {
        const executeResult = await this.opts.adapter.execute(input);
        if (task.abort.signal.aborted) {
          this.settle(task, last, "failed");
          return;
        }
        last = await this.maybeVerify(executeResult, next);
      } catch {
        this.settle(task, last, "failed");
        return;
      }
    }
  }

  private async maybeVerify(
    executeResult: SignedAgentResult,
    objective: string,
  ): Promise<PeerSubmitResponse> {
    if (!this.opts.verifyAfterExecute) {
      return { result: executeResult };
    }
    const budget = this.opts.verifyBudget;
    if (budget !== undefined) {
      const decision = budget.tryReserve();
      if (!decision.allowed) {
        return {
          result: executeResult,
          verifySkipped: { reason: decision.skip.reason },
        };
      }
    }
    try {
      const verdicts = await this.opts.adapter.verify({
        result: executeResult,
        objective,
      });
      budget?.consume();
      return {
        result: executeResult,
        verdict: combinePeerVerdicts(verdicts),
      };
    } catch {
      return { result: executeResult };
    }
  }

  private settle(
    task: RunningPeerTask,
    last: PeerSubmitResponse | undefined,
    status: PeerTaskStatusResult["status"],
  ): void {
    if (task.settled) return;
    task.settled = true;
    task.status = status;
    task.result = last;
    task.completedAt = new Date().toISOString();
    this.wake(task);
    for (const w of task.settleWaiters.splice(0)) w.resolve();
    if (this.settledTtlMs <= 0) {
      this.tasks.delete(task.correlationId);
      return;
    }
    task.gcTimer = setTimeout(() => {
      this.tasks.delete(task.correlationId);
    }, this.settledTtlMs);
    // Allow process to exit in tests without waiting for GC.
    if (typeof task.gcTimer === "object" && "unref" in task.gcTimer) {
      task.gcTimer.unref();
    }
  }
}
