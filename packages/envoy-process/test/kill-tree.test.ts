/**
 * Shared killProcessTree tests — including a real child on win32 so
 * windows-latest CI exercises `taskkill /T /F`.
 */

import { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { killProcessTree } from "../src/kill-tree.js";

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ exited: boolean; code: number | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (exited: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ exited, code });
    };
    child.once("exit", (code) => done(true, code));
    child.once("error", () => done(true, null));
    setTimeout(() => done(false, null), timeoutMs);
  });
}

describe("killProcessTree", () => {
  it("no-ops for invalid pids without throwing", () => {
    expect(() => killProcessTree(undefined)).not.toThrow();
    expect(() => killProcessTree(null)).not.toThrow();
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(-1)).not.toThrow();
  });

  it("on non-win32 sends SIGKILL via process.kill", () => {
    if (process.platform === "win32") return;
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    killProcessTree(12_345);
    expect(spy).toHaveBeenCalledWith(12_345, "SIGKILL");
    spy.mockRestore();
  });

  it("on non-win32 swallows ESRCH from process.kill", () => {
    if (process.platform === "win32") return;
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(() => killProcessTree(99_999)).not.toThrow();
    spy.mockRestore();
  });

  it("terminates a long-running child (taskkill on win32)", async () => {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", "ping -n 60 127.0.0.1"], {
            windowsHide: true,
            stdio: "ignore",
          })
        : spawn("sleep", ["60"], { stdio: "ignore" });

    expect(child.pid).toBeTypeOf("number");
    await new Promise((r) => setTimeout(r, 100));
    killProcessTree(child.pid);
    const result = await waitForExit(child, 5_000);
    expect(result.exited, "child should exit after killProcessTree").toBe(
      true,
    );
  }, 10_000);
});
