/**
 * R6.3 — sidecar cancel keeps the process alive for a follow-up execute.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WindowsSidecarSandboxExecutor } from "../../src/sandbox/backends/windows-sidecar.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/fake-sandbox-sidecar.js",
);

const POLICY = {
  mode: "danger-full-access" as const,
  approval: "never" as const,
  backend: "windows-sandbox" as const,
  writableRoots: [],
  networkAccess: true,
  slashTmpWritable: true,
};

describe("WindowsSidecarSandboxExecutor cancel IPC", () => {
  it("aborts one request then serves another without restarting", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(FIXTURE), `missing fixture ${FIXTURE}`).toBe(true);

    const exec = new WindowsSidecarSandboxExecutor({
      command: FIXTURE,
    });
    const ac = new AbortController();
    const long = exec.execute("SLEEP_LONG", {
      cwd: process.cwd(),
      policy: POLICY,
      signal: ac.signal,
    });
    // Give the execute line time to reach the sidecar before cancelling.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const aborted = await long;
    expect(aborted.stderr, `first: ${JSON.stringify(aborted)}`).not.toMatch(
      /not found|exited/i,
    );
    expect(aborted.isError).toBe(true);

    const second = await exec.execute("echo ok", {
      cwd: process.cwd(),
      policy: POLICY,
      signal: undefined,
    });
    expect(second.stderr, `second failed: ${second.stderr}`).not.toMatch(
      /not found|exited|aborted/i,
    );
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("sidecar-ok");
  }, 10_000);
});
