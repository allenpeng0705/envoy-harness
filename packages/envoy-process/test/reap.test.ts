/**
 * Child reaping: the TERM→KILL ladder plus the bounded pipe teardown.
 *
 * The property under test is **settlement**: `reapChild` must resolve even
 * when the child never emits `close` (a descendant inherited the stdout
 * pipe and outlived the kill). A never-settling reap is precisely the
 * "the agent hangs and stops responding" failure mode.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REAP_GRACE_MS,
  DEFAULT_REAP_SETTLE_MS,
  captureChildIdentity,
  reapChild,
} from "../src/index.js";

/**
 * A fake ChildProcess. `closeSignal` controls whether `close` is ever
 * emitted, so we can model a grandchild holding the pipe.
 */
class FakeChild extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly pidAlive = { value: true };
  readonly signals: string[] = [];

  constructor(options: { pid?: number | undefined } = {}) {
    super();
    this.pid = "pid" in options ? options.pid : 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
}

describe("captureChildIdentity", () => {
  it("captures the pid of a live child", () => {
    const child = new FakeChild({ pid: 999 });
    const identity = captureChildIdentity(child as unknown as ChildProcess);
    expect(identity?.pid).toBe(999);
  });

  it("returns undefined for a child with no pid (spawn not yet settled)", () => {
    expect(captureChildIdentity(new FakeChild({ pid: undefined }) as unknown as ChildProcess)).toBeUndefined();
  });
});

describe("reapChild", () => {
  it("returns false once the child closes on its own", async () => {
    const child = new FakeChild();
    const promise = reapChild(child as unknown as ChildProcess, {
      graceMs: 0,
      settleMs: 50,
      kill: () => {},
      platform: "linux",
    });
    // The child dies promptly.
    child.emit("close", 0, null);
    await expect(promise).resolves.toBe(false);
  });

  it("returns true and tears the pipes down when close never arrives", async () => {
    const child = new FakeChild();
    const stdoutDestroy = vi.spyOn(child.stdout, "destroy");
    const stderrDestroy = vi.spyOn(child.stderr, "destroy");
    const onForceClose = vi.fn();
    // No `close` is ever emitted: a grandchild holds the pipe.
    const forced = await reapChild(child as unknown as ChildProcess, {
      graceMs: 0,
      settleMs: 20,
      kill: () => {},
      platform: "linux",
      onForceClose,
    });
    expect(forced).toBe(true);
    expect(stdoutDestroy).toHaveBeenCalled();
    expect(stderrDestroy).toHaveBeenCalled();
    expect(onForceClose).toHaveBeenCalledTimes(1);
  });

  it("does not force-close when the child was already fully closed", async () => {
    // A fully reaped child: exited AND both pipes gone.
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: 0,
      signalCode: null,
      stdout: null,
      stderr: null,
    });
    const signals: string[] = [];
    const forced = await reapChild(child as unknown as ChildProcess, {
      graceMs: 0,
      settleMs: 20,
      kill: (_pid, signal) => {
        signals.push(signal);
      },
      platform: "linux",
    });
    expect(forced).toBe(false);
    expect(signals).toEqual([]);
  });

  it("still tears the pipes down when the child exited but a pipe is open", async () => {
    // The grandchild case: the leader is gone, the pipe is not.
    const child = new FakeChild();
    child.exitCode = 0;
    const stdoutDestroy = vi.spyOn(child.stdout, "destroy");
    const forced = await reapChild(child as unknown as ChildProcess, {
      graceMs: 0,
      settleMs: 20,
      kill: () => {},
      platform: "linux",
    });
    expect(forced).toBe(true);
    expect(stdoutDestroy).toHaveBeenCalled();
  });

  it("still waits for close when the child exits by signal (code is null)", async () => {
    // The regression this guards: a settle predicate written against the
    // exit code treats `code === null` as "not finished" and hangs.
    const child = new FakeChild();
    const promise = reapChild(child as unknown as ChildProcess, {
      graceMs: 0,
      settleMs: 30,
      kill: () => {},
      platform: "linux",
    });
    child.exitCode = null;
    child.signalCode = "SIGKILL";
    child.emit("close", null, "SIGKILL");
    await expect(promise).resolves.toBe(false);
  });

  it("sends SIGTERM then SIGKILL when the child ignores SIGTERM", async () => {
    const child = new FakeChild();
    const signals: string[] = [];
    const promise = reapChild(child as unknown as ChildProcess, {
      graceMs: 0,
      settleMs: 20,
      kill: (_pid, signal) => {
        signals.push(signal);
      },
      platform: "linux",
    });
    await promise;
    expect(signals).toEqual(["SIGKILL"]);
  });

  it("refuses to signal a recycled pid", async () => {
    const child = new FakeChild({ pid: 77 });
    const signals: string[] = [];
    await reapChild(child as unknown as ChildProcess, {
      graceMs: 0,
      settleMs: 20,
      identity: { pid: 77, startedAt: 1 },
      readIdentity: () => ({ pid: 77, startedAt: 2 }),
      kill: (_pid, signal) => {
        signals.push(signal);
      },
      platform: "linux",
    });
    expect(signals).toEqual([]);
  });

  it("defaults the settle window to half a second", () => {
    expect(DEFAULT_REAP_SETTLE_MS).toBe(500);
  });

  it("defaults the grace to one second (shorter than a plain kill)", async () => {
    expect(DEFAULT_REAP_GRACE_MS).toBe(1000);
    const waits: number[] = [];
    const child = new FakeChild();
    void reapChild(child as unknown as ChildProcess, {
      settleMs: 5,
      wait: async (ms) => {
        waits.push(ms);
      },
      kill: () => {},
      platform: "linux",
    });
    // Give the ladder a tick to reach its sleep.
    await new Promise((r) => setTimeout(r, 10));
    expect(waits).toEqual([1000]);
  });
});
