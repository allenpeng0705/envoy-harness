/**
 * In-process ACP pair for tests and `--demo` smoke.
 */

import { PassThrough } from "node:stream";

import {
  attachAcpServer,
  createFakeSessionBackend,
  JsonRpcConnection,
  type ProtocolSessionBackend,
} from "@envoymesh/envoy-harness";
import { EnvoyHarnessClient } from "@envoymesh/envoy-harness-client";

import { TuiSession, type PermissionRequest } from "./session.js";

export interface InProcessTuiOptions {
  cwd?: string;
  backend?: ProtocolSessionBackend;
  onPermission?: (req: PermissionRequest) => Promise<"allow" | "deny">;
}

export interface InProcessTui {
  session: TuiSession;
  close(): void;
}

/** Create a TuiSession talking to an in-process ACP server. */
export function createInProcessTui(
  options: InProcessTuiOptions = {},
): InProcessTui {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const server = new JsonRpcConnection({ input: c2s, output: s2c });
  const backend = options.backend ?? createFakeSessionBackend();
  attachAcpServer({ connection: server, backend });

  let sessionRef: TuiSession | undefined;
  const client = new EnvoyHarnessClient({
    input: s2c,
    output: c2s,
    onPermissionRequest: async (req) => {
      if (sessionRef === undefined) return "deny";
      return sessionRef.handlePermissionRequest(req);
    },
  });

  const session = new TuiSession({
    client,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.onPermission !== undefined
      ? { onPermission: options.onPermission }
      : {}),
  });
  sessionRef = session;

  return {
    session,
    close() {
      session.close();
      server.close();
      c2s.destroy();
      s2c.destroy();
    },
  };
}
