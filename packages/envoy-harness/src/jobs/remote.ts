/**
 * Mesh-remote job transport seam (Package 1 stub).
 *
 * Hosts (EnvoyMesh adapter) inject a live transport that fetches
 * job snapshots from a peer node. Package 1 only defines the contract.
 */

import type { JobSnapshot } from "./types.js";

export interface RemoteJobTransport {
  /** Fetch a job snapshot from `peer://<peerId>/jobs/<jobId>`. */
  fetchJob(ref: string, signal: AbortSignal): Promise<JobSnapshot>;
}

export class RemoteJobError extends Error {
  override readonly name = "RemoteJobError";
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "NOT_FOUND" | "TRANSPORT",
  ) {
    super(message);
  }
}

/** No-op transport — fails until the mesh adapter wires a real one. */
export const NOOP_REMOTE_JOB_TRANSPORT: RemoteJobTransport = {
  async fetchJob(ref: string): Promise<JobSnapshot> {
    throw new RemoteJobError(
      `remote job ${ref} requires mesh adapter transport`,
      "NOT_CONFIGURED",
    );
  },
};
