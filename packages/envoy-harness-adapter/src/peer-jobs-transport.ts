/**
 * R5.4 — peer-backed {@link RemoteJobTransport} for EnvoyMesh hosts.
 *
 * Same DI shape as {@link createPeerRemoteSubmitterTransport}: resolve a
 * peer from the registry, then speak `peer/jobs/*` over that client.
 */

import type { RemoteJobTransport } from "@envoymesh/envoy-harness";
import {
  parseRemoteJobRef,
  parseRemotePeerId,
  RemoteJobError,
} from "@envoymesh/envoy-harness";
import {
  createPeerRemoteJobTransport,
  type PeerRegistry,
} from "@envoymesh/envoy-harness-peer";

function transportFor(
  registry: PeerRegistry,
  peerId: string,
): RemoteJobTransport {
  const entry = registry.get(peerId);
  if (entry === undefined) {
    throw new RemoteJobError(`no peer for jobs: ${peerId}`, "NOT_FOUND");
  }
  return createPeerRemoteJobTransport({
    peerId,
    client: entry.client,
  });
}

/**
 * Multi-peer {@link RemoteJobTransport}: routes each ref to the matching
 * peer client in the registry.
 */
export function createPeerRemoteJobTransportFromRegistry(
  registry: PeerRegistry,
): RemoteJobTransport {
  return {
    async fetchJob(ref, signal) {
      const { peerId } = parseRemoteJobRef(ref);
      return transportFor(registry, peerId).fetchJob(ref, signal);
    },
    async readOutput(ref, signal) {
      const { peerId } = parseRemoteJobRef(ref);
      return transportFor(registry, peerId).readOutput(ref, signal);
    },
    async kill(ref, signal, reason) {
      const { peerId } = parseRemoteJobRef(ref);
      return transportFor(registry, peerId).kill(ref, signal, reason);
    },
    async listJobs(peerIdOrRef, signal) {
      const peerId = parseRemotePeerId(peerIdOrRef);
      return transportFor(registry, peerId).listJobs(peerIdOrRef, signal);
    },
  };
}
