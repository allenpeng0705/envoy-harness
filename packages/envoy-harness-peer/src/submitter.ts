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
    verdict: { kind: "fail", reason, rollback: false },
  };
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

    const record: SubagentRecord = {
      sessionId: `pending-${correlationId.slice(0, 8)}`,
      capabilityTag: input.capabilityTag,
      objective: input.objective,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.#spawned.push(record);

    let settledResult: SubagentResult | undefined;
    let settleWaiters: Array<{
      resolve: (r: SubagentResult) => void;
      reject: (e: unknown) => void;
    }> = [];
    let startPromise: Promise<void> | undefined;
    let sessionId = record.sessionId;
    let closedLocally = false;

    const syncRecordFromStatus = async (): Promise<void> => {
      const st = await this.#client.taskStatus({ correlationId });
      sessionId = st.sessionId;
      record.sessionId = st.sessionId;
      record.status = st.status;
      if (st.completedAt !== undefined) record.completedAt = st.completedAt;
      if (st.costUsd !== undefined) record.costUsd = st.costUsd;
      if (st.durationMs !== undefined) record.durationMs = st.durationMs;
      if (st.settled) {
        const result =
          st.result !== undefined
            ? signedResultToSubagentResult(st.result.result, st.result.verdict)
            : failedPeerResult(
                this.#workerPeerId,
                st.status === "failed"
                  ? "peer task interrupted or failed"
                  : "peer task settled with no result",
              );
        if (settledResult === undefined) {
          settledResult = result;
          record.status = result.status;
          this.#onSubagentSettle?.(result, { ...record });
          options.onSettle?.(result, { ...record });
          for (const w of settleWaiters.splice(0)) w.resolve(result);
        }
      }
    };

    const ensureStarted = (): Promise<void> => {
      if (startPromise === undefined) {
        startPromise = (async () => {
          const started = await this.#client.submitContinuable({
            correlationId,
            input: wireInput,
          });
          sessionId = started.sessionId;
          record.sessionId = started.sessionId;
          if (started.status !== "running") {
            await syncRecordFromStatus();
          }
        })().catch((err) => {
          settledResult = failedPeerResult(
            this.#workerPeerId,
            err instanceof Error ? err.message : String(err),
          );
          record.status = "failed";
          record.completedAt = new Date().toISOString();
          for (const w of settleWaiters.splice(0)) {
            w.resolve(settledResult!);
          }
          throw err;
        });
      }
      return startPromise;
    };

    // Kick off immediately (non-blocking for caller).
    void ensureStarted();

    if (options.parentSignal !== undefined) {
      const onParentAbort = () => {
        void (async () => {
          try {
            await ensureStarted();
            await this.#client.interruptTask({
              correlationId,
              reason: "parent aborted",
            });
          } catch {
            // ignore
          }
        })();
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
        await this.#client.sendTask({
          correlationId,
          message: messageToText(message),
        });
      },
      interrupt: (reason) => {
        if (settledResult !== undefined) return;
        closedLocally = true;
        void (async () => {
          try {
            await ensureStarted();
            await this.#client.interruptTask({
              correlationId,
              reason: reason ?? "interrupted",
            });
          } catch {
            // ignore — waitSettle will surface failure
          }
        })();
      },
      close: () => {
        if (settledResult !== undefined || closedLocally) return;
        closedLocally = true;
        void (async () => {
          try {
            await ensureStarted();
            await this.#client.closeTask({ correlationId });
          } catch {
            // ignore
          }
        })();
      },
      waitSettle: async (opts) => {
        if (settledResult !== undefined) return settledResult;
        await ensureStarted();
        const timeoutMs = opts?.timeoutMs ?? 120_000;
        const deadline = Date.now() + timeoutMs;
        return new Promise<SubagentResult>((resolve, reject) => {
          const onAbort = () => reject(new Error("waitSettle aborted"));
          opts?.signal?.addEventListener("abort", onAbort, { once: true });
          settleWaiters.push({
            resolve: (r) => {
              opts?.signal?.removeEventListener("abort", onAbort);
              resolve(r);
            },
            reject: (e) => {
              opts?.signal?.removeEventListener("abort", onAbort);
              reject(e);
            },
          });
          const poll = async () => {
            while (settledResult === undefined) {
              if (opts?.signal?.aborted) {
                reject(new Error("waitSettle aborted"));
                return;
              }
              if (Date.now() > deadline) {
                reject(new Error("waitSettle timed out"));
                return;
              }
              try {
                await syncRecordFromStatus();
              } catch (err) {
                reject(err);
                return;
              }
              if (settledResult !== undefined) return;
              await new Promise((r) => setTimeout(r, 20));
            }
          };
          void poll();
        });
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
