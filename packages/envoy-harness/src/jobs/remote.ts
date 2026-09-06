/**
 * Mesh-remote job transport (R4.12).
 *
 * Package 1 defines the contract + a hermetic in-memory fake.
 * Hosts (EnvoyMesh adapter / peer package) inject a live transport that
 * talks MAP / libp2p. Refs use `peer://<peerId>/jobs/<jobId>`.
 */

import type { JobRead, JobRegistry, JobSnapshot } from "./types.js";

export interface RemoteJobRef {
  peerId: string;
  jobId: string;
}

export interface RemoteJobTransport {
  /** Fetch a job snapshot from `peer://<peerId>/jobs/<jobId>`. */
  fetchJob(ref: string, signal: AbortSignal): Promise<JobSnapshot>;
  /** Streaming / retained output for a remote job. */
  readOutput(ref: string, signal: AbortSignal): Promise<JobRead>;
  /** Request cancel on the remote job. */
  kill(
    ref: string,
    signal: AbortSignal,
    reason?: string,
  ): Promise<"requested" | "already-finished">;
  /** List jobs visible on one peer (`peerId` bare or `peer://peerId`). */
  listJobs(peerIdOrRef: string, signal: AbortSignal): Promise<JobSnapshot[]>;
}

export class RemoteJobError extends Error {
  override readonly name = "RemoteJobError";
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "NOT_FOUND" | "TRANSPORT" | "INVALID_REF",
  ) {
    super(message);
  }
}

const PEER_JOB_REF =
  /^peer:\/\/([^/]+)\/jobs\/([^/]+)$/;
const PEER_ONLY =
  /^peer:\/\/([^/]+)\/?$/;

/** Format a remote job ref. */
export function formatRemoteJobRef(peerId: string, jobId: string): string {
  return `peer://${peerId}/jobs/${jobId}`;
}

/** True when `ref` looks like a remote job URI. */
export function isRemoteJobRef(ref: string): boolean {
  return PEER_JOB_REF.test(ref);
}

/**
 * Parse `peer://<peerId>/jobs/<jobId>`.
 * Also accepts bare `peer://<peerId>` via {@link parseRemotePeerId}.
 */
export function parseRemoteJobRef(ref: string): RemoteJobRef {
  const m = PEER_JOB_REF.exec(ref);
  if (m === null || m[1] === undefined || m[2] === undefined) {
    throw new RemoteJobError(
      `invalid remote job ref: ${ref} (expected peer://<peerId>/jobs/<jobId>)`,
      "INVALID_REF",
    );
  }
  return { peerId: decodeURIComponent(m[1]), jobId: decodeURIComponent(m[2]) };
}

/** Parse `peer://<peerId>` or bare peer id for {@link RemoteJobTransport.listJobs}. */
export function parseRemotePeerId(peerIdOrRef: string): string {
  const m = PEER_ONLY.exec(peerIdOrRef);
  if (m?.[1] !== undefined) return decodeURIComponent(m[1]);
  if (peerIdOrRef.includes("://") || peerIdOrRef.includes("/")) {
    throw new RemoteJobError(
      `invalid remote peer id: ${peerIdOrRef}`,
      "INVALID_REF",
    );
  }
  return peerIdOrRef;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RemoteJobError("remote job request aborted", "TRANSPORT");
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
  async readOutput(ref: string): Promise<JobRead> {
    throw new RemoteJobError(
      `remote job ${ref} requires mesh adapter transport`,
      "NOT_CONFIGURED",
    );
  },
  async kill(ref: string): Promise<"requested" | "already-finished"> {
    throw new RemoteJobError(
      `remote job ${ref} requires mesh adapter transport`,
      "NOT_CONFIGURED",
    );
  },
  async listJobs(peerIdOrRef: string): Promise<JobSnapshot[]> {
    throw new RemoteJobError(
      `remote jobs on ${peerIdOrRef} require mesh adapter transport`,
      "NOT_CONFIGURED",
    );
  },
};

/**
 * Hermetic fake: each peer id maps to a local {@link JobRegistry}.
 * EnvoyMesh / peer adapters replace this with a network transport.
 *
 * Optional `viewer` is the session owner used for registry fencing
 * (mesh hosts typically use the remote session id, or leave jobs unowned).
 */
export class FakeRemoteJobTransport implements RemoteJobTransport {
  readonly #peers = new Map<
    string,
    { registry: JobRegistry; viewer?: string }
  >();

  /** Attach (or replace) a peer's job board. */
  attachPeer(
    peerId: string,
    registry: JobRegistry,
    options?: { viewer?: string },
  ): void {
    this.#peers.set(peerId, {
      registry,
      ...(options?.viewer !== undefined ? { viewer: options.viewer } : {}),
    });
  }

  detachPeer(peerId: string): void {
    this.#peers.delete(peerId);
  }

  #peer(peerId: string): { registry: JobRegistry; viewer?: string } {
    const peer = this.#peers.get(peerId);
    if (peer === undefined) {
      throw new RemoteJobError(
        `no remote job peer: ${peerId}`,
        "NOT_FOUND",
      );
    }
    return peer;
  }

  async fetchJob(ref: string, signal: AbortSignal): Promise<JobSnapshot> {
    throwIfAborted(signal);
    const { peerId, jobId } = parseRemoteJobRef(ref);
    const peer = this.#peer(peerId);
    try {
      return peer.registry.get(jobId, peer.viewer);
    } catch (err) {
      throw new RemoteJobError(
        err instanceof Error ? err.message : String(err),
        "NOT_FOUND",
      );
    }
  }

  async readOutput(ref: string, signal: AbortSignal): Promise<JobRead> {
    throwIfAborted(signal);
    const { peerId, jobId } = parseRemoteJobRef(ref);
    const peer = this.#peer(peerId);
    try {
      return peer.registry.read(jobId, peer.viewer);
    } catch (err) {
      throw new RemoteJobError(
        err instanceof Error ? err.message : String(err),
        "NOT_FOUND",
      );
    }
  }

  async kill(
    ref: string,
    signal: AbortSignal,
    reason?: string,
  ): Promise<"requested" | "already-finished"> {
    throwIfAborted(signal);
    const { peerId, jobId } = parseRemoteJobRef(ref);
    const peer = this.#peer(peerId);
    try {
      return peer.registry.kill(jobId, peer.viewer, reason);
    } catch (err) {
      throw new RemoteJobError(
        err instanceof Error ? err.message : String(err),
        "NOT_FOUND",
      );
    }
  }

  async listJobs(
    peerIdOrRef: string,
    signal: AbortSignal,
  ): Promise<JobSnapshot[]> {
    throwIfAborted(signal);
    const peerId = parseRemotePeerId(peerIdOrRef);
    const peer = this.#peer(peerId);
    return peer.registry.list(peer.viewer);
  }
}
