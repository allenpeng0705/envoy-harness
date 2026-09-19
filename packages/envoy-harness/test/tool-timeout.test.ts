/**
 * Per-tool timeouts — hermetic tests.
 *
 * Closes the "`git`/`write`/`edit` can hang the turn forever" gap. The
 * three behaviours that matter and are easy to get wrong:
 *
 * 1. A cooperative tool is cancelled at the deadline and its own
 *    settle is used (we must not report a timeout for a tool that
 *    actually finished).
 * 2. A tool that ignores cancellation is **abandoned** after a grace
 *    period, and the result says so — because the operation may still
 *    be running and may still take effect.
 * 3. An outer abort is never mislabelled as a timeout.
 *
 * Fake timers and an injected clock throughout: no real waiting.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TOOL_TIMEOUT_MS,
  ToolTimeoutError,
  isToolTimeout,
  runWithToolTimeout,
} from "../src/index.js";

/** A manual timer queue so tests drive deadlines deterministically. */
function createTimers() {
  let now = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      if (typeof handle === "number") queue.delete(handle);
    },
    /** Advance time, firing due timers. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...queue.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [id, timer] = due[0]!;
        queue.delete(id);
        now = timer.at;
        timer.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
    },
  };
}

describe("runWithToolTimeout", () => {
  it("returns a fast tool's result unchanged", async () => {
    const timers = createTimers();
    const outcome = await runWithToolTimeout({
      timeoutMs: 1000,
      signal: new AbortController().signal,
      body: async () => "done",
      onTimeout: () => "TIMEOUT",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(outcome).toEqual({ result: "done", timedOut: false, abandoned: false });
  });

  it("cancels a cooperative tool at the deadline and uses its settle", async () => {
    const timers = createTimers();
    let sawAbort = false;

    const run = runWithToolTimeout({
      timeoutMs: 1000,
      signal: new AbortController().signal,
      body: async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve();
          });
        });
        return "cancelled-cleanly";
      },
      onTimeout: () => "TIMEOUT",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await timers.advance(1000);
    const outcome = await run;

    // The tool honoured the signal, so its own settle is the truth.
    expect(sawAbort).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.result).toBe("cancelled-cleanly");
  });

  it("abandons a tool that ignores cancellation, and says so", async () => {
    const timers = createTimers();

    const run = runWithToolTimeout({
      timeoutMs: 1000,
      graceMs: 100,
      signal: new AbortController().signal,
      // Never settles, never listens to the signal.
      body: () => new Promise<string>(() => {}),
      onTimeout: ({ timeoutMs, abandoned }) =>
        abandoned ? `abandoned after ${timeoutMs}ms` : "timeout",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await timers.advance(1100);
    const outcome = await run;

    expect(outcome.timedOut).toBe(true);
    expect(outcome.abandoned).toBe(true);
    expect(outcome.result).toBe("abandoned after 1000ms");
  });

  it("reports a clean timeout when the tool rejects BECAUSE of the deadline", async () => {
    const timers = createTimers();
    const run = runWithToolTimeout({
      timeoutMs: 500,
      signal: new AbortController().signal,
      body: async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        );
        throw new ToolTimeoutError(500);
      },
      onTimeout: ({ abandoned }) => (abandoned ? "ABANDONED" : "TIMEOUT"),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await timers.advance(500);
    const outcome = await run;
    expect(outcome.timedOut).toBe(true);
    expect(outcome.abandoned).toBe(false);
    expect(outcome.result).toBe("TIMEOUT");
  });

  it("rethrows a genuine tool failure (not a timeout)", async () => {
    const timers = createTimers();
    await expect(
      runWithToolTimeout({
        timeoutMs: 1000,
        signal: new AbortController().signal,
        body: async () => {
          throw new Error("disk on fire");
        },
        onTimeout: () => "TIMEOUT",
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      }),
    ).rejects.toThrow("disk on fire");
  });

  it("never mislabels an OUTER abort as a timeout", async () => {
    const timers = createTimers();
    const outer = new AbortController();

    const run = runWithToolTimeout({
      timeoutMs: 10_000,
      signal: outer.signal,
      body: async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        );
        throw new Error("aborted by caller");
      },
      onTimeout: () => "TIMEOUT",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    outer.abort(new Error("user pressed Ctrl-C"));
    await timers.advance(1);
    // The caller's abort must surface as the caller's error.
    await expect(run).rejects.toThrow("aborted by caller");
  });

  it("respects timeoutMs 0 as 'no budget'", async () => {
    const timers = createTimers();
    const outcome = await runWithToolTimeout({
      timeoutMs: 0,
      signal: new AbortController().signal,
      body: async () => "unbounded",
      onTimeout: () => "TIMEOUT",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.result).toBe("unbounded");
  });

  it("defaults to a finite budget when the tool declares none", () => {
    // A missing budget must NOT mean "unbounded" — that was the bug.
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_TOOL_TIMEOUT_MS)).toBe(true);
  });

  it("clears its timers on every path", async () => {
    const clearTimer = vi.fn();
    await runWithToolTimeout({
      timeoutMs: 1000,
      signal: new AbortController().signal,
      body: async () => "ok",
      onTimeout: () => "TIMEOUT",
      setTimer: () => 1,
      clearTimer,
    });
    // Both the deadline timer and the grace timer are cleared.
    expect(clearTimer).toHaveBeenCalledTimes(2);
  });
});

describe("isToolTimeout", () => {
  it("recognizes the typed error and the code", () => {
    expect(isToolTimeout(new ToolTimeoutError(5))).toBe(true);
    expect(isToolTimeout({ code: "TOOL_TIMEOUT" })).toBe(true);
    expect(isToolTimeout(new Error("nope"))).toBe(false);
    expect(isToolTimeout(undefined)).toBe(false);
  });
});
