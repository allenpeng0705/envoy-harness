/**
 * F2b sidecar execute — hermetic on non-Windows.
 */

import { describe, expect, it } from "vitest";

import { executeSandboxed } from "../src/execute.js";

const READ_ONLY = {
  mode: "read-only" as const,
  approval: "on-request" as const,
  backend: "windows-sandbox" as const,
  writableRoots: [],
  networkAccess: false,
  slashTmpWritable: true,
};

describe("executeSandboxed", () => {
  it("runs echo on the current platform", async () => {
    const result = await executeSandboxed({
      command: "echo sidecar-ok",
      cwd: process.cwd(),
      policy: READ_ONLY,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("sidecar-ok");
    expect(result.fsIsolation).toBe(false);
  });

  it("R6.3 — abort signal ends a long sleep promptly", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const pending = executeSandboxed({
      command:
        process.platform === "win32"
          ? "ping -n 30 127.0.0.1 >nul"
          : "sleep 30",
      cwd: process.cwd(),
      policy: READ_ONLY,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.exitCode === 0 && !result.isError).toBe(false);
  }, 10_000);
});
