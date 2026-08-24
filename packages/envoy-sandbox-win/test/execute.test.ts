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
});
