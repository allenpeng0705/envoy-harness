/**
 * R5.2 — live {@link RemoteExecTransport} over peer JSON-RPC.
 */

import type {
  ExecReadResult,
  ExecShellRequest,
  ExecShellResult,
  RemoteExecTransport,
} from "@envoymesh/envoy-harness";
import { ExecWorldError } from "@envoymesh/envoy-harness";

import type { PeerClient } from "./client.js";

export interface PeerRemoteExecTransportOptions {
  /** Identity of the peer this client is connected to. */
  peerId: string;
  client: PeerClient;
}

/**
 * Maps Package-1 {@link RemoteExecTransport} onto `peer/exec/*` RPCs
 * for a single connected peer.
 */
export function createPeerRemoteExecTransport(
  options: PeerRemoteExecTransportOptions,
): RemoteExecTransport {
  const { peerId, client } = options;

  const assertPeer = (id: string): void => {
    if (id !== peerId) {
      throw new ExecWorldError(
        `peer exec transport is bound to ${peerId}, got ${id}`,
        "NOT_FOUND",
      );
    }
  };

  return {
    async readFile(id, filePath, opts, signal) {
      assertPeer(id);
      return client.execRead(filePath, opts, signal);
    },
    async writeFile(id, filePath, content, opts, signal) {
      assertPeer(id);
      await client.execWrite(filePath, content, opts, signal);
    },
    async runShell(id, request: ExecShellRequest, signal) {
      assertPeer(id);
      return client.execShell(request, signal);
    },
  };
}

export type { ExecReadResult, ExecShellResult };
