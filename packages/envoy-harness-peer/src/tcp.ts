/**
 * R2 — `connectPeerClient`: the production TCP transport for the peer
 * dialect. Connects a `PeerClient` to a peer server over a real socket.
 */

import { connect, type Socket } from "node:net";
import { once } from "node:events";

import { JsonRpcConnection } from "@envoymesh/envoy-harness";

import { PeerClient } from "./client.js";
import type { PeerEventSink } from "./events.js";
import type { PeerSigner } from "./envelope.js";

export interface TcpPeerClientOptions {
  host: string;
  port: number;
  /** R2 — connect timeout (default 10s). */
  connectTimeoutMs?: number;
  /** D7 — request signing. */
  signer?: PeerSigner;
  /** D7 — observability sink. */
  onEvent?: PeerEventSink;
  /** Per-request timeout (default 30s). */
  requestTimeoutMs?: number;
}

export interface TcpPeerClient {
  client: PeerClient;
  socket: Socket;
  close(): void;
}

export async function connectPeerClient(
  options: TcpPeerClientOptions,
): Promise<TcpPeerClient> {
  const socket = connect({
    host: options.host,
    port: options.port,
  });
  const timeoutMs = options.connectTimeoutMs ?? 10_000;
  const timer = setTimeout(() => {
    socket.destroy(new Error(`peer connect timed out (${options.host}:${options.port})`));
  }, timeoutMs);
  try {
    await once(socket, "connect");
  } catch (err) {
    clearTimeout(timer);
    socket.destroy();
    throw err;
  }
  clearTimeout(timer);
  const client = new PeerClient({
    connection: new JsonRpcConnection({ input: socket, output: socket }),
    ...(options.signer !== undefined ? { signer: options.signer } : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
  });
  return {
    client,
    socket,
    close() {
      socket.destroy();
    },
  };
}
