/**
 * R6.2 — spawnCapture aborts long-running children promptly.
 */

import { describe, expect, it } from "vitest";

import { spawnCapture } from "../../src/sandbox/backends/spawn-capture.js";

describe("spawnCapture abort", () => {
  it("settles quickly when the signal aborts a long sleep", async () => {
    const ac = new AbortController();
    const sleepCmd =
      process.platform === "win32"
        ? { file: "cmd.exe", args: ["/d", "/s", "/c", "ping -n 30 127.0.0.1 >nul"] }
        : { file: "sh", args: ["-c", "sleep 30"] };

    const started = Date.now();
    const pending = spawnCapture({
      ...sleepCmd,
      cwd: process.cwd(),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    const result = await pending;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    // Aborted children typically exit non-zero / signalled.
    expect(result.exitCode === 0 && !result.isError).toBe(false);
  }, 10_000);
});
