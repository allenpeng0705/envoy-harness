/**
 * Spawn `envoy-harness --acp` and attach a TuiSession.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  spawnAcpServer,
  type SpawnAcpOptions,
} from "@envoymesh/envoy-harness-client";

import { TuiSession, type PermissionRequest } from "./session.js";

export interface SpawnedTuiOptions {
  cwd?: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  onPermission?: (req: PermissionRequest) => Promise<"allow" | "deny">;
  stderr?: SpawnAcpOptions["stderr"];
}

export interface SpawnedTui {
  session: TuiSession;
  close(): void;
}

/** Resolve `envoy-harness --acp` for monorepo + installed layouts. */
export function resolveHarnessAcpCommand(): {
  command: string;
  args: string[];
} {
  if (process.env.ENVOY_HARNESS_BIN) {
    return { command: process.env.ENVOY_HARNESS_BIN, args: ["--acp"] };
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const siblingTs = path.resolve(
    here,
    "../../envoy-harness/bin/envoy-harness.ts",
  );
  if (existsSync(siblingTs)) {
    return {
      command: process.execPath,
      args: ["--import", "tsx", siblingTs, "--acp"],
    };
  }

  return { command: "envoy-harness", args: ["--acp"] };
}

/** Spawn harness `--acp` and return an attached TuiSession. */
export function createSpawnedTui(
  options: SpawnedTuiOptions = {},
): SpawnedTui {
  const resolved =
    options.command !== undefined
      ? { command: options.command, args: options.args ?? ["--acp"] }
      : resolveHarnessAcpCommand();

  let sessionRef: TuiSession | undefined;
  const spawned = spawnAcpServer({
    command: resolved.command,
    args: resolved.args,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
    onPermissionRequest: async (req) => {
      if (sessionRef === undefined) return "deny";
      return sessionRef.handlePermissionRequest(req);
    },
  });

  const session = new TuiSession({
    client: spawned.client,
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
      spawned.close();
    },
  };
}
