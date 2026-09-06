/**
 * ACP notification parsing — matches Package 1 wire shapes.
 */
import { describe, expect, it } from "vitest";
import {
  mergePromptRows,
  parseSessionTokenDelta,
  parseSessionUpdateMessage,
  rowsFromPromptResult,
} from "../src/client/acp/acp-notifications.js";

describe("parseSessionTokenDelta", () => {
  it("reads ACP { sessionId, token: { role, delta } }", () => {
    expect(
      parseSessionTokenDelta(
        {
          sessionId: "s1",
          token: { role: "assistant", delta: "Hel" },
        },
        "s1",
      ),
    ).toBe("Hel");
  });

  it("ignores other sessions and empty deltas", () => {
    expect(
      parseSessionTokenDelta(
        { sessionId: "other", token: { role: "assistant", delta: "x" } },
        "s1",
      ),
    ).toBeUndefined();
    expect(
      parseSessionTokenDelta(
        { sessionId: "s1", token: { role: "assistant", delta: "" } },
        "s1",
      ),
    ).toBeUndefined();
  });
});

describe("parseSessionUpdateMessage", () => {
  it("reads ACP { sessionId, message: { role, text } }", () => {
    expect(
      parseSessionUpdateMessage(
        {
          sessionId: "s1",
          message: { role: "assistant", text: "Hello" },
        },
        "s1",
      ),
    ).toEqual({ role: "assistant", text: "Hello" });
    expect(
      parseSessionUpdateMessage(
        {
          sessionId: "s1",
          message: { role: "tool", text: "ok" },
        },
        "s1",
      ),
    ).toEqual({ role: "tool", text: "ok" });
  });

  it("skips user rows and wrong session", () => {
    expect(
      parseSessionUpdateMessage(
        { sessionId: "s1", message: { role: "user", text: "hi" } },
        "s1",
      ),
    ).toBeUndefined();
  });
});

describe("rowsFromPromptResult / mergePromptRows", () => {
  it("keeps tool rows and finalizes assistant", () => {
    const rows = rowsFromPromptResult([
      { role: "user", text: "hi" },
      { role: "assistant", text: "done" },
      { role: "tool", text: "ls out" },
    ]);
    expect(rows).toEqual([
      { role: "assistant", text: "done" },
      { role: "tool", text: "ls out" },
    ]);
    expect(
      mergePromptRows(
        [
          { role: "user", text: "hi" },
          { role: "assistant", text: "par" },
        ],
        rows,
      ),
    ).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "done" },
      { role: "tool", text: "ls out" },
    ]);
  });
});
