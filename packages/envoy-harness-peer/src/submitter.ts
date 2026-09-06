/**
 * D2 — `PeerMeshSubmitter`: the `MeshSubmitter` implementation that
 * submits sub-agent tasks to a standalone envoy-harness peer (same or
 * different machine, possibly a different model) over the peer dialect.
 *
 * Same contract as `LocalMeshSubmitter` / `RemoteMeshSubmitter` — the
 * agent loop's `task` tool doesn't know which one it is.
 *
 * R4.9b adds `submitContinuable` / `getHandle` mirroring the local path.
 */

import { randomUUID } from "node:crypto";

import type {
  ContinuableSubagentHandle,
  ContentBlock,
  MeshSubmitter,
  SubagentRecord,
  SubagentInput,
  SubagentResult,
  SubmitContinuableOptions,
} from "@envoymesh/envoy-harness";

import { PeerClient } from "./client.js";
import {
  subagentInputToExecuteInput,
  signedResultToSubagentResult,
} from "./mapping.js";
import type { PeerTaskStatusResult } from "./messages.js";

export interface PeerMeshSubmitterOptions {
  /** The typed peer client (connection + dialect). */
  client: PeerClient;
  /** Fallback worker peerId when the peer's result omits its own
   *  (the wire result's `peerId` is authoritative). Default `"peer"`. */
  workerPeerId?: string;
  /** Fired once when a continuable handle settles. */
  onSubagentSettle?: (result: SubagentResult, record: SubagentRecord) => void;
}

function messageToText(message: string | ReadonlyArray<ContentBlock>): string {
  if (typeof message === "string") return message;
  return message
    .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
    .join("\n");
}

function failedPeerResult(
  workerPeerId: string,
  reason: string,
): SubagentResult {
  return {
    status: "failed",
    content: [{ type: "text", text: reason }],
    workerPeerId,
    workerRuntime: "envoy-harness",
    costUsd: 0,
    durationMs: 0,
    signature: "",
    verdict: { kind: "fail", reason, rollback: false },
  };
}

function applyStatusToRecord(
  record: SubagentRecord,
  st: PeerTaskStatusResult,
): void {
  record.sessionId = st.sessionId;
  record.status = st.status;
  if (st.completedAt !== undefined) record.completedAt = st.completedAt;
  if (st.costUsd !== undefined) record.costUsd = st.costUsd;
  if (st.durationMs !== undefined) record.durationMs = st.durationMs;
}

export class PeerMeshSubmitter implements MeshSubmitter {
  readonly #client: PeerClient;
  readonly #workerPeerId: string;
  readonly #onSubagentSettle:
    | ((result: SubagentResult, record: SubagentRecord) => void)
    | undefined;
  #spawned: SubagentRecord[] = [];
  #handles = new Map<string, ContinuableSubagentHandle>();

  constructor(options: PeerMeshSubmitterOptions) {
    this.#client = options.client;
    this.#workerPeerId = options.workerPeerId ?? "peer";
    this.#onSubagentSettle = options.onSubagentSettle;
  }

  async submit(
    input: SubagentInput,
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    const startedAt = new Date().toISOString();
    const wire = await this.#client.executeWithVerdict(
      subagentInputToExecuteInput(input, signal),
      signal,
    );
    const result = signedResultToSubagentResult(wire.result, wire.verdict);
    const workerPeerId = result.workerPeerId || this.#workerPeerId;
    this.#spawned.push({
      sessionId: `${workerPeerId}-${this.#spawned.length}`,
      capabilityTag: input.capabilityTag,
      objective: input.objective,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      status: result.status,
    });
    return result;
  }

  /**
   * R4.9b — non-blocking spawn over `peer/submitContinuable`.
   * Blocking `submit()` is unchanged.
   *
   * `autoSettleAfterIdle` is forwarded to the peer (default false).
   * `interrupt` / `close` enqueue RPCs; `send` / `waitSettle` drain
   * that queue so control is ordered before observe.
   */
  submitContinuable(
    input: SubagentInput,
    options: SubmitContinuableOptions = {},
  ): ContinuableSubagentHandle {
    const correlationId = randomUUID();
    const executeInput = subagentInputToExecuteInput(
      input,
      new AbortController().signal,
    );
    const wireInput = PeerClient.toWireExecuteInput({
      ...executeInput,
      correlationId,
    });
    const autoSettleAfterIdle = options.autoSettleAfterIdle === true;

    const record: SubagentRecord = {
      sessionId: `pending-${correlationId.slice(0, 8)}`,
      capabilityTag: input.capabilityTag,
      objective: input.objective,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.#spawned.push(record);

    let settledResult: SubagentResult | undefined;
    let startPromise: Promise<void> | undefined;
    let sessionId = record.sessionId;
    let closedLocally = false;
    /** Serializes interrupt/close RPCs; send/waitSettle await it. */
    let controlQueue: Promise<void> = Promise.resolve();

    const enqueueControl = (fn: () => Promise<void>): Promise<void> => {
      const next = controlQueue.then(fn, fn);
      controlQueue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

    const markSettled = (result: SubagentResult): void => {
      if (settledResult !== undefined) return;
      settledResult = result;
      record.status = result.status;
      if (record.completedAt === undefined) {
        record.completedAt = new Date().toISOString();
      }
      this.#onSubagentSettle?.(result, { ...record });
      options.onSettle?.(result, { ...record });
    };

    const resultFromStatus = (st: PeerTaskStatusResult): SubagentResult => {
      applyStatusToRecord(record, st);
      sessionId = st.sessionId;
      if (st.result !== undefined) {
        return signedResultToSubagentResult(st.result.result, st.result.verdict);
      }
      return failedPeerResult(
        this.#workerPeerId,
        st.status === "failed"
          ? "peer task interrupted or failed"
          : "peer task settled with no result",
      );
    };

    const ensureStarted = (): Promise<void> => {
      if (startPromise === undefined) {
        startPromise = (async () => {
          const started = await this.#client.submitContinuable({
            correlationId,
            input: wireInput,
            autoSettleAfterIdle,
          });
          sessionId = started.sessionId;
          record.sessionId = started.sessionId;
          if (started.status !== "running") {
            const st = await this.#client.taskStatus({ correlationId });
            if (st.settled) markSettled(resultFromStatus(st));
          }
        })().catch((err) => {
          markSettled(
            failedPeerResult(
              this.#workerPeerId,
              err instanceof Error ? err.message : String(err),
            ),
          );
          // Do not rethrow — void kickoff must not become unhandled rejection.
        });
      }
      return startPromise;
    };

    void ensureStarted();

    if (options.parentSignal !== undefined) {
      const onParentAbort = () => {
        void enqueueControl(async () => {
          await ensureStarted();
          if (settledResult !== undefined) return;
          await this.#client.interruptTask({
            correlationId,
            reason: "parent aborted",
          });
        });
      };
      if (options.parentSignal.aborted) onParentAbort();
      else {
        options.parentSignal.addEventListener("abort", onParentAbort, {
          once: true,
        });
      }
    }

    const handle: ContinuableSubagentHandle = {
      get id() {
        return correlationId;
      },
      get sessionId() {
        return sessionId;
      },
      send: async (message) => {
        if (settledResult !== undefined) {
          throw new Error(`peer task ${correlationId} already settled`);
        }
        await ensureStarted();
        await controlQueue;
        if (settledResult !== undefined) {
          throw new Error(`peer task ${correlationId} already settled`);
        }
        await this.#client.sendTask({
          correlationId,
          message: messageToText(message),
        });
      },
      interrupt: (reason) => {
        if (settledResult !== undefined) return;
        closedLocally = true;
        void enqueueControl(async () => {
          await ensureStarted();
          if (settledResult !== undefined) return;
          await this.#client.interruptTask({
            correlationId,
            reason: reason ?? "interrupted",
          });
        });
      },
      close: () => {
        if (settledResult !== undefined || closedLocally) return;
        closedLocally = true;
        void enqueueControl(async () => {
          await ensureStarted();
          if (settledResult !== undefined) return;
          await this.#client.closeTask({ correlationId });
        });
      },
      waitSettle: async (opts) => {
        if (settledResult !== undefined) return settledResult;
        await ensureStarted();
        await controlQueue;
        if (settledResult !== undefined) return settledResult;

        const timeoutMs = opts?.timeoutMs ?? 120_000;
        if (opts?.signal?.aborted) {
          throw new Error("waitSettle aborted");
        }

        try {
          const st = await this.#client.waitTaskSettle(
            { correlationId, timeoutMs },
            opts?.signal,
          );
          if (settledResult !== undefined) return settledResult;
          const result = resultFromStatus(st);
          markSettled(result);
          return result;
        } catch (err) {
          if (settledResult !== undefined) return settledResult;
          throw err;
        }
      },
      status: () => ({ ...record }),
    };

    this.#handles.set(correlationId, handle);
    return handle;
  }

  getHandle(id: string): ContinuableSubagentHandle | undefined {
    return this.#handles.get(id);
  }

  /** F17.6 — a snapshot of peers this submitter has spawned. */
  listSubagents(): ReadonlyArray<SubagentRecord> {
    return this.#spawned;
  }
}
