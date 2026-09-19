/**
 * Process-tree termination: TERM→KILL ladder, process-group targeting,
 * and the PID-reuse fence. Every probe and signal is injected, so nothing
 * is spawned and no real process is signalled.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TERM_GRACE_MS,
  identityMatches,
  terminateProcessTree,
  type ProcessIdentity,
} from "../src/index.js";

interface SignalRecord {
  readonly target: number;
  readonly signal: NodeJS.Signals;
}

function harness(
  options: { alive?: boolean; identity?: ProcessIdentity | undefined } = {},
) {
  const signals: SignalRecord[] = [];
  let alive = options.alive ?? true;
  return {
    signals,
    kill(target: number, signal: NodeJS.Signals) {
      if (!alive) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      signals.push({ target, signal });
      if (signal === "SIGKILL") alive = false;
    },
    readIdentity: () => options.identity,
    wait: async () => {
      // The process does not exit during the grace period.
    },
  };
}

describe("terminateProcessTree", () => {
  it("sends SIGTERM, waits the grace, then SIGKILL", async () => {
    const h = harness();
    await terminateProcessTree(1234, {
      graceMs: 3000,
      kill: h.kill,
      wait: h.wait,
      platform: "linux",
    });
    expect(h.signals).toEqual([
      { target: 1234, signal: "SIGTERM" },
      { target: 1234, signal: "SIGKILL" },
    ]);
  });

  it("uses a 3s default grace", async () => {
    expect(DEFAULT_TERM_GRACE_MS).toBe(3000);
    const waits: number[] = [];
    const h = harness();
    await terminateProcessTree(1, {
      kill: h.kill,
      wait: async (ms) => {
        waits.push(ms);
      },
      platform: "linux",
    });
    expect(waits).toEqual([3000]);
  });

  it("skips SIGTERM when graceMs is 0 (kill immediately)", async () => {
    const h = harness();
    await terminateProcessTree(9, {
      graceMs: 0,
      kill: h.kill,
      platform: "linux",
    });
    expect(h.signals).toEqual([{ target: 9, signal: "SIGKILL" }]);
  });

  it("targets the process GROUP when asked (catches backgrounded children)", async () => {
    const h = harness();
    await terminateProcessTree(500, {
      graceMs: 0,
      processGroup: true,
      kill: h.kill,
      platform: "linux",
    });
    expect(h.signals[0]?.target).toBe(-500);
  });

  it("stops after SIGTERM when the process is already gone", async () => {
    const h = harness({ alive: false });
    await terminateProcessTree(7, {
      graceMs: 100,
      kill: h.kill,
      wait: h.wait,
      platform: "linux",
    });
    // SIGTERM failed with ESRCH, so no SIGKILL is attempted.
    expect(h.signals).toEqual([]);
  });

  it("never throws for an invalid pid", async () => {
    for (const pid of [undefined, null, 0, -1, Number.NaN]) {
      await expect(
        terminateProcessTree(pid, { graceMs: 0 }),
      ).resolves.toBeUndefined();
    }
  });
});

describe("PID-reuse fence", () => {
  const identity: ProcessIdentity = { pid: 42, startedAt: 1000 };

  it("signals when the identity still matches", async () => {
    const h = harness({ identity });
    await terminateProcessTree(42, {
      graceMs: 0,
      identity,
      kill: h.kill,
      readIdentity: h.readIdentity,
      platform: "linux",
    });
    expect(h.signals).toHaveLength(1);
  });

  it("REFUSES to signal a recycled pid", async () => {
    // Same pid, different start marker: a different process.
    const h = harness({ identity: { pid: 42, startedAt: 9999 } });
    await terminateProcessTree(42, {
      graceMs: 0,
      identity,
      kill: h.kill,
      readIdentity: h.readIdentity,
      platform: "linux",
    });
    expect(h.signals).toEqual([]);
  });

  it("REFUSES when the process is gone", async () => {
    const h = harness({ identity: undefined });
    await terminateProcessTree(42, {
      graceMs: 0,
      identity,
      kill: h.kill,
      readIdentity: h.readIdentity,
      platform: "linux",
    });
    expect(h.signals).toEqual([]);
  });

  it("falls back to a liveness-only fence where no start marker exists", () => {
    const noMarker: ProcessIdentity = { pid: 42, startedAt: undefined };
    expect(identityMatches(noMarker, () => ({ pid: 42, startedAt: 5 }))).toBe(true);
    expect(identityMatches(noMarker, () => undefined)).toBe(false);
  });

  it("compares start markers when both sides have one", () => {
    const a: ProcessIdentity = { pid: 1, startedAt: 10 };
    expect(identityMatches(a, () => ({ pid: 1, startedAt: 10 }))).toBe(true);
    expect(identityMatches(a, () => ({ pid: 1, startedAt: 11 }))).toBe(false);
  });
});

describe("Windows path", () => {
  it("delegates to taskkill (tree kill)", async () => {
    // Not asserting on taskkill execution — only that the ladder does not
    // send POSIX signals on win32.
    const kill = vi.fn();
    await terminateProcessTree(11, {
      graceMs: 0,
      kill,
      platform: "win32",
    });
    expect(kill).not.toHaveBeenCalled();
  });
});
