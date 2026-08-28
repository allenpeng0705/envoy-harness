/**
 * Message formatting for mid-run session/update.
 */

import { describe, expect, it } from "vitest";

import {
  messageTextFromContent,
  traceEventToCommittedMessage,
} from "../../src/protocol/message-format.js";

describe("traceEventToCommittedMessage", () => {
  it("maps model_response text to assistant message", () => {
    const msg = traceEventToCommittedMessage({
      kind: "model_response",
      ts: "2026-01-01T00:00:00.000Z",
      iteration: 1,
      stopReason: "end_turn",
      content: [{ type: "text", text: "Hello world" }],
    });
    expect(msg).toEqual({ role: "assistant", text: "Hello world" });
  });

  it("maps tool_result to tool role message", () => {
    const msg = traceEventToCommittedMessage({
      kind: "tool_result",
      ts: "2026-01-01T00:00:00.000Z",
      iteration: 1,
      callId: "c1",
      toolName: "write",
      result: { content: "written ok" },
      durationMs: 5,
    });
    expect(msg?.role).toBe("tool");
    expect(msg?.text).toContain("written ok");
  });

  it("messageTextFromContent joins text blocks", () => {
    expect(
      messageTextFromContent([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });
});
