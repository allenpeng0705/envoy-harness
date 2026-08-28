/**
 * D2 — `PeerMeshSubmitter`: the `MeshSubmitter` implementation that
 * submits sub-agent tasks to a standalone envoy-harness peer (same or
 * different machine, possibly a different model) over the peer dialect.
 *
 * Same contract as `LocalMeshSubmitter` / `RemoteMeshSubmitter` — the
 * agent loop's `task` tool doesn't know which one it is.
 */

import type {
  MeshSubmitter,
  SubagentRecord,
  SubagentInput,
  SubagentResult,
} from "@envoymesh/envoy-harness";

import type { PeerClient } from "./client.js";
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
}

export class PeerMeshSubmitter implements MeshSubmitter {
  readonly #client: PeerClient;
  readonly #workerPeerId: string;
  #spawned: SubagentRecord[] = [];

  constructor(options: PeerMeshSubmitterOptions) {
    this.#client = options.client;
    this.#workerPeerId = options.workerPeerId ?? "peer";
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

  /** F17.6 — a snapshot of peers this submitter has spawned. */
  listSubagents(): ReadonlyArray<SubagentRecord> {
    return this.#spawned;
  }
}
