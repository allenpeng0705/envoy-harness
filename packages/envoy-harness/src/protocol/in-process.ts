/**
 * Phase E — in-process JSON-RPC pair (PassThrough streams).
 */

import { PassThrough } from "node:stream";

import { JsonRpcConnection } from "./connection.js";

export interface InProcessPair {
  client: JsonRpcConnection;
  server: JsonRpcConnection;
  close(): void;
}

export function createInProcessJsonRpcPair(): InProcessPair {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const client = new JsonRpcConnection({ input: s2c, output: c2s });
  const server = new JsonRpcConnection({ input: c2s, output: s2c });
  return {
    client,
    server,
    close() {
      client.close();
      server.close();
      c2s.destroy();
      s2c.destroy();
    },
  };
}
