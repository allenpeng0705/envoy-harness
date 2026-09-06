#!/usr/bin/env node
/**
 * `envoy-sandbox-win` — long-lived sidecar (newline JSON on stdin/stdout).
 *
 * R6.3: requests are handled concurrently so `cancel` can arrive while
 * an `execute` is in flight. Each execute owns an AbortController keyed
 * by request id.
 */

import * as readline from "node:readline";

import { executeSandboxed } from "./execute.js";
import type {
  SidecarCancelParams,
  SidecarExecuteParams,
  SidecarRequest,
  SidecarResponse,
} from "./protocol.js";

const inFlight = new Map<string, AbortController>();

function writeResponse(res: SidecarResponse): void {
  process.stdout.write(JSON.stringify(res) + "\n");
}

async function handle(req: SidecarRequest): Promise<SidecarResponse> {
  if (req.method === "ping") {
    return {
      id: req.id,
      ok: true,
      result: { pong: true, platform: process.platform },
    };
  }
  if (req.method === "cancel") {
    const params = req.params as SidecarCancelParams | undefined;
    if (params?.id === undefined || params.id.length === 0) {
      return { id: req.id, ok: false, error: "cancel requires params.id" };
    }
    const ac = inFlight.get(params.id);
    if (ac !== undefined) {
      ac.abort();
    }
    return { id: req.id, ok: true, result: { cancelled: true } };
  }
  if (req.method === "execute") {
    const params = req.params as SidecarExecuteParams | undefined;
    if (params === undefined) {
      return { id: req.id, ok: false, error: "execute requires params" };
    }
    const ac = new AbortController();
    inFlight.set(req.id, ac);
    try {
      const result = await executeSandboxed({
        command: params.command,
        cwd: params.cwd,
        policy: params.policy,
        ...(params.maxOutputBytes !== undefined
          ? { maxOutputBytes: params.maxOutputBytes }
          : {}),
        signal: ac.signal,
      });
      return { id: req.id, ok: true, result };
    } finally {
      inFlight.delete(req.id);
    }
  }
  return { id: req.id, ok: false, error: `unknown method: ${req.method}` };
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  // Readline advances while `handle()` promises run — cancel can arrive
  // mid-execute without waiting for the prior request to finish.
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let req: SidecarRequest;
    try {
      req = JSON.parse(trimmed) as SidecarRequest;
    } catch {
      writeResponse({
        id: "",
        ok: false,
        error: "invalid JSON",
      });
      continue;
    }
    void handle(req)
      .then((res) => writeResponse(res))
      .catch((err) => {
        writeResponse({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
