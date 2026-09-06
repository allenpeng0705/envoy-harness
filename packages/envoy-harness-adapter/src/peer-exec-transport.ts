/**
 * R5.4 — peer-backed {@link RemoteExecTransport} for EnvoyMesh hosts.
 */

import type { RemoteExecTransport } from "@envoymesh/envoy-harness";
import { ExecWorldError } from "@envoymesh/envoy-harness";
import {
  createPeerRemoteExecTransport,
  type PeerRegistry,
} from "@envoymesh/envoy-harness-peer";

function transportFor(
  registry: PeerRegistry,
  peerId: string,
): RemoteExecTransport {
  const entry = registry.get(peerId);
  if (entry === undefined) {
    throw new ExecWorldError(`no peer for exec: ${peerId}`, "NOT_FOUND");
  }
  return createPeerRemoteExecTransport({
    peerId,
    client: entry.client,
  });
}

/**
 * Multi-peer {@link RemoteExecTransport}: routes each call to the matching
 * peer client in the registry.
 */
export function createPeerRemoteExecTransportFromRegistry(
  registry: PeerRegistry,
): RemoteExecTransport {
  return {
    async readFile(peerId, filePath, options, signal) {
      return transportFor(registry, peerId).readFile(
        peerId,
        filePath,
        options,
        signal,
      );
    },
    async writeFile(peerId, filePath, content, options, signal) {
      return transportFor(registry, peerId).writeFile(
        peerId,
        filePath,
        content,
        options,
        signal,
      );
    },
    async runShell(peerId, request, signal) {
      return transportFor(registry, peerId).runShell(peerId, request, signal);
    },
  };
}
