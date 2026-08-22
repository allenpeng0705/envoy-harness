/**
 * D2 — `createInProcessPeerPair`: a hermetic client/server pair over two
 * `PassThrough` streams (the ACP test pattern). The server side uses the
 * injected handler; the client side is a `PeerClient`.
 */

import { PassThrough } from "node:stream";

import { JsonRpcConnection, type RequestHandler } from "@envoymesh/envoy-harness";

import { PeerClient } from "./client.js";

export interface InProcessPeerPair {
  client: PeerClient;
  /** The server-side connection (for disposal / direct handler access). */
  server: JsonRpcConnection;
  close(): void;
}

export function createInProcessPeerPair(
  handler: RequestHandler,
  options?: { requestTimeoutMs?: number },
): InProcessPeerPair {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const server = new JsonRpcConnection({
    input: clientToServer,
    output: serverToClient,
    onRequest: handler,
  });
  const client = new PeerClient({
    connection: new JsonRpcConnection({
      input: serverToClient,
      output: clientToServer,
    }),
    ...(options?.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
  });
  return {
    client,
    server,
    close() {
      clientToServer.destroy();
      serverToClient.destroy();
    },
  };
}
