/**
 * Attach a TuiSession to an existing ACP stdio pair.
 */

import type { Readable, Writable } from "node:stream";

import {
  EnvoyHarnessClient,
  type EnvoyHarnessClientOptions,
} from "@envoymesh/envoy-harness-client";

import { TuiSession, type PermissionRequest } from "./session.js";

export interface AttachedTuiOptions {
  input: Readable;
  output: Writable;
  cwd?: string;
  onPermission?: (req: PermissionRequest) => Promise<"allow" | "deny">;
  onEvent?: EnvoyHarnessClientOptions["onEvent"];
}

export interface AttachedTui {
  session: TuiSession;
  client: EnvoyHarnessClient;
  close(): void;
}

/** Create a TuiSession over host-provided ACP streams (no server spawn). */
export function createAttachedTui(options: AttachedTuiOptions): AttachedTui {
  let sessionRef: TuiSession | undefined;
  const client = new EnvoyHarnessClient({
    input: options.input,
    output: options.output,
    onPermissionRequest: async (req) => {
      if (sessionRef === undefined) return "deny";
      return sessionRef.handlePermissionRequest(req);
    },
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
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
    client,
    close() {
      session.close();
    },
  };
}
