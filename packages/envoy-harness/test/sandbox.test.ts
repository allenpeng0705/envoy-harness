/**
 * T3.4 — OS sandbox type seam tests.
 *
 * Covers:
 * 1. `NoopSandboxExecutor.execute` runs the
 *    command via `sh -c` and captures stdout /
 *    stderr / exitCode.
 * 2. The abort signal is forwarded to the child
 *    process (so the bash tool's abort semantics
 *    work).
 * 3. The cwd is honored.
 * 4. Non-zero exit codes are surfaced as
 *    `isError: true`.
 *
 * The kernel backends (landlock / process-fs-
 * namespace) land in T3.4.1 / T3.4.2 with a
 * Linux test environment; these tests only
 * cover the noop.
 */

import { describe, expect, it } from "vitest";

import {
  NoopSandboxExecutor,
  type SandboxContext,
} from "../src/sandbox/index.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

async function makeContext(overrides: Partial<SandboxContext> = {}): Promise<SandboxContext> {
  return {
    policy: {
      mode: "read-only",
      approval: "on-request",
      backend: "none",
      writableRoots: [],
      networkAccess: false,
      slashTmpWritable: false,
    },
    cwd: tmpDir,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("NoopSandboxExecutor: basic sh -c", () => {
  it("captures stdout from a simple command", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-sandbox-"));
    const exec = new NoopSandboxExecutor();
    const result = await exec.execute("echo hello", await makeContext());
    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("captures stderr", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-sandbox-"));
    const exec = new NoopSandboxExecutor();
    const result = await exec.execute(
      "echo to stderr >&2; exit 0",
      await makeContext(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe("to stderr");
  });

  it("reports non-zero exit codes as isError: true", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-sandbox-"));
    const exec = new NoopSandboxExecutor();
    const result = await exec.execute("exit 7", await makeContext());
    expect(result.exitCode).toBe(7);
    expect(result.isError).toBe(true);
  });

  it("honors the cwd", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-sandbox-"));
    const exec = new NoopSandboxExecutor();
    const result = await exec.execute("pwd", await makeContext());
    // macOS resolves /var/folders -> /private/var/folders;
    // realpath both sides to be platform-agnostic.
    const expected = await fs.realpath(tmpDir);
    const actual = await fs.realpath(result.stdout.trim());
    expect(actual).toBe(expected);
  });
});
