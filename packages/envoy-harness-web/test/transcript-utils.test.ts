/**
 * Transcript grouping + permission preview helpers.
 */
import { describe, expect, it } from "vitest";
import {
  groupTranscript,
  permissionPreview,
} from "../src/client/transcript-utils.js";
import type { ChatMessage } from "../src/client/acp/host.js";

function msg(
  id: string,
  role: ChatMessage["role"],
  text: string,
): ChatMessage {
  return { id, role, text, at: 0 };
}

describe("groupTranscript", () => {
  it("folds consecutive status/tool rows", () => {
    const items = groupTranscript([
      msg("1", "user", "hi"),
      msg("2", "status", "tool bash"),
      msg("3", "tool", "tool: bash"),
      msg("4", "assistant", "done"),
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "message" });
    expect(items[1]).toMatchObject({ kind: "activity" });
    if (items[1]?.kind === "activity") {
      expect(items[1].messages).toHaveLength(2);
    }
    expect(items[2]).toMatchObject({ kind: "message" });
  });
});

describe("permissionPreview", () => {
  it("surfaces command/path before raw JSON", () => {
    const preview = permissionPreview({
      command: "npm install",
      path: "/tmp/x",
      other: 1,
    });
    expect(preview.summary).toEqual([
      "command: npm install",
      "path: /tmp/x",
    ]);
    expect(preview.raw).toContain('"other"');
  });
});
