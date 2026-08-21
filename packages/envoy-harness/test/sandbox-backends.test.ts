/**
 * Phase F — OS sandbox backends (hermetic).
 */

import { describe, expect, it } from "vitest";

import {
  LandlockSandboxExecutor,
  type LandlockLauncherApi,
  NoopSandboxExecutor,
  policyToLandlockGrants,
  policyToSeatbeltProfile,
  resolveSandboxExecutor,
  SeatbeltSandboxExecutor,
  type SandboxContext,
} from "../src/sandbox/index.js";
import type { SandboxPolicy } from "../src/types.js";

const READ_ONLY: SandboxPolicy = {
  mode: "read-only",
  approval: "on-request",
  backend: "linux-landlock",
  writableRoots: [],
  networkAccess: false,
  slashTmpWritable: true,
};

const WORKSPACE: SandboxPolicy = {
  mode: "workspace-write",
  approval: "on-request",
  backend: "linux-landlock",
  writableRoots: ["/proj"],
  networkAccess: false,
  slashTmpWritable: true,
};

function makeCtx(policy: SandboxPolicy, cwd = process.cwd()): SandboxContext {
  return { policy, cwd, signal: new AbortController().signal };
}

describe("policyToLandlockGrants", () => {
  it("grants read-only / and /tmp for read-only mode", () => {
    expect(policyToLandlockGrants(READ_ONLY, "/proj")).toEqual({
      readOnly: ["/"],
      readWrite: ["/tmp"],
    });
  });

  it("adds writable roots for workspace-write", () => {
    expect(policyToLandlockGrants(WORKSPACE, "/proj")).toEqual({
      readOnly: ["/"],
      readWrite: ["/proj", "/tmp"],
    });
  });
});

describe("policyToSeatbeltProfile", () => {
  it("denies network when networkAccess is false", () => {
    const profile = policyToSeatbeltProfile(WORKSPACE, "/proj");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow file-write* (subpath "/proj"))');
  });

  it("allows default for danger-full-access", () => {
    const profile = policyToSeatbeltProfile(
      {
        mode: "danger-full-access",
        approval: "never",
        backend: "none",
        writableRoots: [],
        networkAccess: true,
        slashTmpWritable: true,
      },
      "/proj",
    );
    expect(profile).toContain("(allow default)");
  });
});

describe("resolveSandboxExecutor", () => {
  it("returns noop when backend is none", () => {
    const exec = resolveSandboxExecutor({
      policy: {
        ...READ_ONLY,
        backend: "none",
        mode: "danger-full-access",
      },
      platform: "linux",
    });
    expect(exec).toBeInstanceOf(NoopSandboxExecutor);
  });

  it("picks landlock when forced", () => {
    const exec = resolveSandboxExecutor({
      policy: READ_ONLY,
      platform: "linux",
      force: "landlock",
      landlock: { api: fakeApi(), onUnusable: "error" },
    });
    expect(exec).toBeInstanceOf(LandlockSandboxExecutor);
  });

  it("picks seatbelt when forced", () => {
    const exec = resolveSandboxExecutor({
      policy: READ_ONLY,
      platform: "darwin",
      force: "seatbelt",
      seatbelt: { binary: "false" },
    });
    expect(exec).toBeInstanceOf(SeatbeltSandboxExecutor);
  });
});

describe("LandlockSandboxExecutor with fake launcher", () => {
  it("fail-closes when probe is unusable", async () => {
    const exec = new LandlockSandboxExecutor({
      api: {
        LAUNCHER_FAILURE_EXIT: 125,
        launcherPath: () => "/nonexistent-landlock-run",
        probe: () => "unusable",
        grantArgs: () => [],
      },
      onUnusable: "error",
    });
    const result = await exec.execute("echo hi", makeCtx(READ_ONLY));
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toMatch(/sandbox unavailable/i);
  });

  it("falls back to bare sh when onUnusable is noop", async () => {
    const exec = new LandlockSandboxExecutor({
      api: {
        LAUNCHER_FAILURE_EXIT: 125,
        launcherPath: () => "/missing",
        probe: () => "unusable",
        grantArgs: () => [],
      },
      onUnusable: "noop",
    });
    const result = await exec.execute("echo hello-f", makeCtx(READ_ONLY));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello-f");
  });
});

describe("SeatbeltSandboxExecutor fail-closed", () => {
  it("returns error when binary is missing", async () => {
    const exec = new SeatbeltSandboxExecutor({
      binary: "/nonexistent-sandbox-exec",
      onUnusable: "error",
    });
    const result = await exec.execute("echo hi", makeCtx(WORKSPACE));
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toMatch(/sandbox unavailable/i);
  });
});

function fakeApi(): LandlockLauncherApi {
  return {
    LAUNCHER_FAILURE_EXIT: 125,
    launcherPath: () => "/bin/true",
    probe: () => "full",
    grantArgs: () => [],
  };
}
