/**
 * Phase C / Item 9 parity — PTY quiescence ("readiness detection") and
 * bounded UTF-8 result caps.
 */

import { describe, expect, it } from "vitest";

import {
  capTextUtf8,
  waitForQuiescence,
} from "../../src/terminal/index.js";

describe("waitForQuiescence", () => {
  it("resolves inferred_idle once output stops growing", async () => {
    const lines: string[] = [""];
    const result = waitForQuiescence({
      lines,
      getStatus: () => ({ kind: "running" }),
      quietMs: 40,
      pollMs: 10,
      timeoutMs: 2_000,
    });
    // Feed some output, then stop.
    lines[0] = "hello";
    lines.push("world");
    expect(await result).toBe("inferred_idle");
  });

  it("resolves timeout while output keeps flowing", async () => {
    const lines: string[] = [""];
    const result = waitForQuiescence({
      lines,
      getStatus: () => ({ kind: "running" }),
      quietMs: 100,
      pollMs: 10,
      timeoutMs: 120,
    });
    const feed = setInterval(() => {
      lines.push(`line-${Date.now()}`);
    }, 15);
    try {
      expect(await result).toBe("timeout");
    } finally {
      clearInterval(feed);
    }
  });

  it("resolves session_exit when the terminal exits", async () => {
    const lines: string[] = [""];
    let status: { kind: "running" } | { kind: "exited"; exitCode: number | null; signal: null } =
      { kind: "running" };
    const result = waitForQuiescence({
      lines,
      getStatus: () => status,
      quietMs: 10_000,
      pollMs: 10,
      timeoutMs: 10_000,
    });
    setTimeout(() => {
      status = { kind: "exited", exitCode: 0, signal: null };
    }, 30);
    expect(await result).toBe("session_exit");
  });
});

describe("capTextUtf8", () => {
  it("returns short text unchanged", () => {
    expect(capTextUtf8("hello", 100)).toEqual({
      text: "hello",
      truncated: false,
    });
  });

  it("truncates on a UTF-8 boundary without corrupting multi-byte chars", () => {
    const emoji = "a😀b".repeat(50); // 4-byte chars
    const capped = capTextUtf8(emoji, 20);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text, "utf8")).toBeLessThanOrEqual(20);
    // The cut must not split a surrogate pair / 4-byte sequence.
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(capped.text),
    )).not.toThrow();
  });
});
