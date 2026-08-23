/**
 * Transcript formatting — Claude Code–style readability.
 */

import { describe, expect, it } from "vitest";

import {
  formatMessageBody,
  formatPermissionBlock,
  formatTranscriptLine,
} from "../src/transcript.js";

describe("formatTranscriptLine", () => {
  it("indents continued assistant lines and fences code", () => {
    const text = formatTranscriptLine({
      role: "assistant",
      text: "Here:\n```\nls\n```\nDone.",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(text).toContain("[agent] Here:");
    expect(text).toContain("┌─ code ─");
    expect(text).toContain("│ ls");
    expect(text).toContain("└─");
    expect(text).toContain("Done.");
  });

  it("formats tool output with ⎿ continuation", () => {
    const text = formatTranscriptLine({
      role: "tool",
      text: "line1\nline2",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(text).toContain("[tool] line1");
    expect(text).toContain("⎿ line2");
  });
});

describe("formatPermissionBlock", () => {
  it("includes tool name, description, and args", () => {
    const block = formatPermissionBlock({
      toolName: "bash",
      description: "Run shell command?",
      args: { command: "ls -la" },
    });
    expect(block).toContain("Allow tool `bash`?");
    expect(block).toContain("Run shell command?");
    expect(block).toContain("ls -la");
    expect(block).toContain("allow or deny");
  });
});

describe("formatMessageBody", () => {
  it("surfaces tool denials clearly", () => {
    expect(
      formatMessageBody("tool", "denied by user: host denied"),
    ).toContain("denied — host denied");
  });
});
