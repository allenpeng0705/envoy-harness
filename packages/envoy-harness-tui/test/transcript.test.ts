/**
 * Transcript formatting — Claude Code–style readability.
 */

import { describe, expect, it } from "vitest";

import {
  formatMessageBody,
  formatPermissionBlock,
  formatTranscriptLine,
} from "../src/transcript.js";
import { stripAnsi } from "../src/theme.js";

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
    expect(text).toContain("[tool]");
    expect(text).toContain("✓");
    expect(text).toContain("line1");
    expect(text).toContain("⎿ line2");
  });

  it("U6a.3 — prefixes bash tools with ⚙ and colors when requested", () => {
    const text = formatTranscriptLine(
      {
        role: "tool",
        text: "bash\noutput",
        at: "2026-01-01T00:00:00.000Z",
      },
      { useColor: true },
    );
    expect(stripAnsi(text)).toContain("⚙ bash");
    expect(text).toContain("\x1b[");
  });
});

describe("formatPermissionBlock", () => {
  it("includes tool name, description, and args in a box", () => {
    const block = formatPermissionBlock({
      toolName: "bash",
      description: "Run shell command?",
      args: { command: "ls -la" },
    });
    expect(block).toContain("Allow tool bash?");
    expect(block).toContain("Run shell command?");
    expect(block).toContain("ls -la");
    expect(block).toContain("allow or deny");
    expect(block).toContain("┌");
    expect(block).toContain("└");
  });

  it("truncates long previews with scroll window and hint", () => {
    const preview = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
    const block = formatPermissionBlock(
      {
        toolName: "write",
        description: "Write file?",
        args: {},
      },
      preview,
    );
    expect(block).toContain("lines 1–10 of 15");
    expect(block).toContain("j/k");
    expect(block).not.toContain("line 14");
  });

  it("U6a.4 — previewOffset scrolls the window", () => {
    const preview = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
    const block = formatPermissionBlock(
      {
        toolName: "write",
        description: "Write file?",
        args: {},
      },
      preview,
      { previewOffset: 5 },
    );
    expect(block).toContain("line 5");
    expect(block).toContain("line 14");
    expect(block).toContain("lines 6–15 of 15");
    expect(block).not.toContain("line 0");
  });
});

describe("formatMessageBody", () => {
  it("surfaces tool denials clearly", () => {
    expect(
      formatMessageBody("tool", "denied by user: host denied"),
    ).toContain("denied — host denied");
  });
});
