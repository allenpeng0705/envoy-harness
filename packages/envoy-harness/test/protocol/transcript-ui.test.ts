/**
 * UI transcript flattening for session/load hydrate.
 */
import { describe, expect, it } from "vitest";
import { messagesToUiTranscript } from "../../src/protocol/transcript-ui.js";

describe("messagesToUiTranscript", () => {
  it("keeps user/assistant text and summarizes tool calls", () => {
    const rows = messagesToUiTranscript([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          {
            type: "tool_call",
            id: "1",
            name: "bash",
            args: { command: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "1",
            content: "a\nb",
            isError: false,
          },
        ],
      },
    ]);
    expect(rows[0]).toEqual({ role: "user", text: "hello" });
    expect(rows[1]?.text).toContain("running");
    expect(rows[1]?.text).toContain("bash");
    expect(rows[2]).toEqual({ role: "tool", text: "a\nb" });
  });
});
