#!/usr/bin/env node
/**
 * `envoy-sandbox-win` — long-lived sidecar (newline JSON on stdin/stdout).
 */

import * as readline from "node:readline";

import { executeSandboxed } from "./execute.js";
import type { SidecarRequest, SidecarResponse } from "./protocol.js";

async function handle(req: SidecarRequest): Promise<SidecarResponse> {
  if (req.method === "ping") {
    return {
      id: req.id,
      ok: true,
      result: { pong: true, platform: process.platform },
    };
  }
  if (req.method === "execute") {
    if (req.params === undefined) {
      return { id: req.id, ok: false, error: "execute requires params" };
    }
    const result = await executeSandboxed({
      command: req.params.command,
      cwd: req.params.cwd,
      policy: req.params.policy,
      ...(req.params.maxOutputBytes !== undefined
        ? { maxOutputBytes: req.params.maxOutputBytes }
        : {}),
    });
    return { id: req.id, ok: true, result };
  }
  return { id: req.id, ok: false, error: `unknown method: ${req.method}` };
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let req: SidecarRequest;
    try {
      req = JSON.parse(trimmed) as SidecarRequest;
    } catch {
      process.stdout.write(
        JSON.stringify({
          id: "",
          ok: false,
          error: "invalid JSON",
        }) + "\n",
      );
      continue;
    }
    try {
      const res = await handle(req);
      process.stdout.write(JSON.stringify(res) + "\n");
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
