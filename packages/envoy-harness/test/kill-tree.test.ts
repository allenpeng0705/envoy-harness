/**
 * R6.1 — killProcessTree unit tests (hermetic).
 */

import { describe, expect, it, vi } from "vitest";

describe("killProcessTree", () => {
  it("no-ops for invalid pids without throwing", async () => {
    const { killProcessTree } = await import("../src/process/kill-tree.js");
    expect(() => killProcessTree(undefined)).not.toThrow();
    expect(() => killProcessTree(null)).not.toThrow();
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(-1)).not.toThrow();
  });

  it("on non-win32 sends SIGKILL via process.kill", async () => {
    if (process.platform === "win32") return;
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { killProcessTree } = await import("../src/process/kill-tree.js");
    killProcessTree(12_345);
    expect(spy).toHaveBeenCalledWith(12_345, "SIGKILL");
    spy.mockRestore();
  });

  it("on non-win32 swallows ESRCH from process.kill", async () => {
    if (process.platform === "win32") return;
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    const { killProcessTree } = await import("../src/process/kill-tree.js");
    expect(() => killProcessTree(99_999)).not.toThrow();
    spy.mockRestore();
  });
});
