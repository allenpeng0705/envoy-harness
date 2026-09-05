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

interface RunningPeerTask {
  correlationId: string;
  sessionId: string;
  wire: WireExecuteInput;
  inbox: string[];
  abort: AbortController;
  closed: boolean;
  settled: boolean;
  status: PeerTaskStatusResult["status"];
  result: PeerSubmitResponse | undefined;
  startedAt: string;
  completedAt: string | undefined;
  workWaiters: Array<() => void>;
  pump: Promise<void>;
}

export interface PeerContinuableTaskRegistryOptions {
  adapter: AgentAdapter;
  peerId: string;
  verifyAfterExecute?: boolean;
  maxVerifyAfterExecute?: number;
  /** Mutable counter shared with blocking submit path (optional). */
  verifyCount?: { value: number };
}

export class PeerContinuableTaskRegistry {
  private readonly tasks = new Map<string, RunningPeerTask>();
  private readonly opts: PeerContinuableTaskRegistryOptions;

  constructor(opts: PeerContinuableTaskRegistryOptions) {
    this.opts = opts;
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
      status: "running",
      result: undefined,
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      workWaiters: [],
      pump: Promise.resolve(),
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
    try {
      while (!task.settled) {
        const next = task.inbox.shift();
        if (next === undefined) {
          if (task.abort.signal.aborted) {
            this.settle(task, last, "failed");
            return;
          }
          if (task.closed) {
            this.settle(task, last, last !== undefined ? "completed" : "failed");
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
    } finally {
      // no-op — settle always happens on exit paths above
    }
  }

  private async maybeVerify(
    executeResult: SignedAgentResult,
    objective: string,
  ): Promise<PeerSubmitResponse> {
    if (!this.opts.verifyAfterExecute) {
      return { result: executeResult };
    }
    const counter = this.opts.verifyCount;
    if (
      this.opts.maxVerifyAfterExecute !== undefined &&
      counter !== undefined &&
      counter.value >= this.opts.maxVerifyAfterExecute
    ) {
      return { result: executeResult };
    }
    try {
      const verdicts = await this.opts.adapter.verify({
        result: executeResult,
        objective,
      });
      if (counter !== undefined) counter.value += 1;
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
  }
}
