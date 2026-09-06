/**
 * R5.1 — live {@link RemoteJobTransport} over peer JSON-RPC.
 */

import {
  formatRemoteJobRef,
  parseRemoteJobRef,
  parseRemotePeerId,
  RemoteJobError,
  type JobRead,
  type JobSnapshot,
  type RemoteJobTransport,
} from "@envoymesh/envoy-harness";

import type { PeerClient } from "./client.js";

export interface PeerRemoteJobTransportOptions {
  /** Identity of the peer this client is connected to. */
  peerId: string;
  client: PeerClient;
}

/**
 * Maps Package-1 {@link RemoteJobTransport} onto `peer/jobs/*` RPCs
 * for a single connected peer.
 */
export function createPeerRemoteJobTransport(
  options: PeerRemoteJobTransportOptions,
): RemoteJobTransport {
  const { peerId, client } = options;

  const assertPeer = (refPeerId: string): void => {
    if (refPeerId !== peerId) {
      throw new RemoteJobError(
        `peer job transport is bound to ${peerId}, got ${refPeerId}`,
        "NOT_FOUND",
      );
    }
  };

  return {
    async fetchJob(ref, signal) {
      const parsed = parseRemoteJobRef(ref);
      assertPeer(parsed.peerId);
      return client.jobsFetch(parsed.jobId, signal);
    },
    async readOutput(ref, signal) {
      const parsed = parseRemoteJobRef(ref);
      assertPeer(parsed.peerId);
      return client.jobsRead(parsed.jobId, signal);
    },
    async kill(ref, signal, reason) {
      const parsed = parseRemoteJobRef(ref);
      assertPeer(parsed.peerId);
      return client.jobsKill(parsed.jobId, signal, reason);
    },
    async listJobs(peerIdOrRef, signal) {
      const id = parseRemotePeerId(peerIdOrRef);
      assertPeer(id);
      return client.jobsList(signal);
    },
  };
}

/** Convenience: build a full `peer://` ref for this transport's peer. */
export function peerJobRef(
  options: PeerRemoteJobTransportOptions,
  jobId: string,
): string {
  return formatRemoteJobRef(options.peerId, jobId);
}

export type { JobRead, JobSnapshot };
