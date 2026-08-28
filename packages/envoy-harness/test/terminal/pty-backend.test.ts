/**
 * Phase C — node-pty backend availability + contract (hermetic).
 */

import { describe, expect, it } from "vitest";

import {
  createPtyTerminalBackend,
  isPtyAvailable,
} from "../../src/terminal/pty-backend.js";

describe("pty-backend", () => {
  it("isPtyAvailable returns a boolean", () => {
    expect(typeof isPtyAvailable()).toBe("boolean");
  });

  it("createPtyTerminalBackend exposes type pty", () => {
    const backend = createPtyTerminalBackend();
    expect(backend.type).toBe("pty");
  });

  it("spawn rejects when node-pty is unavailable", async () => {
    if (isPtyAvailable()) return;
    const backend = createPtyTerminalBackend();
    await expect(
      backend.spawn({
        type: "pty",
        sessionId: "pty-1",
        owner: "test",
      }),
    ).rejects.toThrow(/node-pty is not available/);
  });
});
