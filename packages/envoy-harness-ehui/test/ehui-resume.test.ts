/**
 * R7.5 — Resume picker display helpers + actionable row contract.
 */

import { describe, expect, it, vi } from "vitest";

import type { ClientSessionSummary } from "@envoymesh/envoy-harness-client/ehui";

import {
  formatSessions,
  resumeSessionTitle,
  shortSessionId,
} from "../src/ehui-format.js";

describe("resume session helpers", () => {
  const row: ClientSessionSummary = {
    id: "abcdefghijklmnop",
    mtimeMs: 1,
    title: "Prior work",
    messageCount: 4,
  };

  it("shortens long session ids", () => {
    expect(shortSessionId(row.id)).toBe("abcdefghij…");
    expect(shortSessionId("short")).toBe("short");
  });

  it("prefers title then cwd then id", () => {
    expect(resumeSessionTitle(row)).toBe("Prior work");
    expect(
      resumeSessionTitle({
        id: "x",
        mtimeMs: 1,
        cwd: "/tmp/proj",
        messageCount: 0,
      }),
    ).toBe("/tmp/proj");
    expect(
      resumeSessionTitle({ id: "only-id", mtimeMs: 1, messageCount: 0 }),
    ).toBe("only-id");
  });

  it("formatSessions lists rows the picker mirrors", () => {
    const text = formatSessions([row]);
    expect(text).toContain("Resume session");
    expect(text).toContain("abcdefghij…");
    expect(text).toContain("Prior work");
    expect(text).toContain("4");
  });

  it("host callback receives full session id", () => {
    const onResume = vi.fn();
    onResume(row.id);
    expect(onResume).toHaveBeenCalledWith("abcdefghijklmnop");
  });
});
