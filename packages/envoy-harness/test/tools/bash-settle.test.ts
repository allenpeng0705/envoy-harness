/**
 * Settlement guarantees for spawned shells.
 *
 * **The bug these lock down.** `sh -c 'sleep 30 & echo hi'` exits
 * immediately, but the backgrounded `sleep` inherits the write end of our
 * stdout pipe. Node's `close` event waits for *both* the process to exit
 * and the stdio pipes to close, so the tool's promise never settles: the
 * agent stalls with no timeout, no error, and no way out. A timeout kill
 * that only signals the shell does not help, because the shell is already
 * gone.
 *
 * These tests are hermetic — they spawn `sh` but never touch the network,
 * a model, or the mesh — and are deliberately bounded: a regression
 * surfaces as a vitest timeout, which is the correct signal.
 */

import { describe, expect, it } from "vitest";

import { InMemorySession, newSessionId } from "../../src/session.js";
import { spawnCapture } from "../../src/sandbox/backends/spawn-capture.js";
import { bashTool } from "../../src/tools/builtin/bash.js";

function session(cwd: string) {
  return new InMemorySession(newSessionId(), {
    cwd,
    startedAt: new Date().toISOString(),
    permissionMode: "danger-full-access",
  });
}

function ctx(cwd: string) {
  return {
    cwd,
    session: session(cwd),
    abortSignal: AbortSignal.timeout(60_000),
  };
}

describe("bash: a backgrounded descendant cannot hang the tool", () => {
  it("returns on the timeout even though a grandchild holds stdout", async () => {
    const started = Date.now();
    const result = await bashTool.execute(
      { command: "sleep 30 & echo backgrounded", timeoutMs: 400 },
      ctx(process.cwd()),
    );
    const elapsed = Date.now() - started;
    // Generous upper bound: the point is "seconds, not thirty".
    expect(elapsed).toBeLessThan(10_000);
    expect(String(result.content)).toContain("backgrounded");
    expect(String(result.content)).toContain("[command was killed]");
  }, 20_000);

  it("returns promptly when the shell exits and the job is disowned", async () => {
    const result = await bashTool.execute(
      { command: "setsid sleep 30 >/dev/null 2>&1 & echo disowned", timeoutMs: 400 },
      ctx(process.cwd()),
    );
    expect(String(result.content)).toContain("disowned");
  }, 20_000);
});

describe("bash: signal death still resolves", () => {
  it("reports a killed command rather than hanging on a null exit code", async () => {
    // `kill -KILL $$` kills the shell by signal, so `code` is null. The
    // old settle predicate keyed off the code and never resolved.
    const result = await bashTool.execute(
      { command: "kill -KILL $$" },
      ctx(process.cwd()),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/exit code: (137|null)/);
  }, 20_000);
});

describe("spawnCapture settlement", () => {
  it("resolves a signal-killed process and reports the signal", async () => {
    const result = await spawnCapture({
      file: "sh",
      args: ["-c", "kill -KILL $$"],
      cwd: process.cwd(),
      signal: undefined,
    });
    expect(result.signal).toBe("SIGKILL");
    expect(result.isError).toBe(true);
  }, 20_000);

  it("resolves on abort even when a grandchild holds the pipe", async () => {
    const ac = new AbortController();
    const pending = spawnCapture({
      file: "sh",
      args: ["-c", "sleep 30 & echo started; wait"],
      cwd: process.cwd(),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 200);
    const result = await pending;
    expect(result.stdout).toContain("started");
    expect(result.isError).toBe(true);
  }, 20_000);
});
