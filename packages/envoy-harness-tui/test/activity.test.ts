import { describe, expect, it } from "vitest";

import { formatActivityLine, formatTurnEndCard } from "../src/activity.js";

describe("formatActivityLine", () => {
  it("formats tool call and result like Codex", () => {
    expect(
      formatActivityLine({
        kind: "tool_call",
        summary: "bash — ls -la",
      }),
    ).toBe("⏺ bash — ls -la");
    expect(
      formatActivityLine({
        kind: "tool_result",
        summary: "listed files",
        durationMs: 42,
      }),
    ).toBe("  ⎿ listed files (42ms)");
  });

  it("indents sub-agent activity", () => {
    expect(
      formatActivityLine({
        kind: "tool_call",
        summary: "spawn sub-agent",
        subagentOf: "parent-session",
      }),
    ).toBe("  ↳ ⏺ spawn sub-agent");
  });

  it("formats live bash stdout progress", () => {
    expect(
      formatActivityLine({
        kind: "tool_progress",
        summary: "building…",
      }),
    ).toBe("  ⎿ building…");
  });
});

describe("formatTurnEndCard", () => {
  it("includes cost line when present", () => {
    const text = formatTurnEndCard({
      kind: "agent_end",
      summary: "done — 2 model turns",
      costUsd: 0.0123,
    });
    expect(text).toContain("Turn complete");
    expect(text).toContain("cost: $0.0123");
  });
});
