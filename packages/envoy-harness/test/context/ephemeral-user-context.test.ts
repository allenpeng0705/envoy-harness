import { describe, expect, it } from "vitest";

import {
  injectEphemeralUserContext,
  isEphemeralUserContextText,
  isEphemeralUserMessage,
} from "../../src/context/ephemeral-user-context.js";

describe("isEphemeralUserContextText", () => {
  it("detects skill catalog blocks", () => {
    expect(
      isEphemeralUserContextText(
        "<available_skills><skill name=\"demo\">A skill</skill></available_skills>",
      ),
    ).toBe(true);
  });

  it("detects plan and memory index fragments", () => {
    expect(
      isEphemeralUserContextText("ACTIVE PLAN (approved at 2026-01-01):\n\nDo X"),
    ).toBe(true);
    expect(
      isEphemeralUserContextText(
        "Available memories (read with `read_file memories/<name>.md`):\n\n- [foo] Title",
      ),
    ).toBe(true);
  });

  it("does not flag normal human prompts", () => {
    expect(isEphemeralUserContextText("review the agent loop")).toBe(false);
  });
});

describe("injectEphemeralUserContext", () => {
  it("inserts ephemeral context before the trailing user prompt", () => {
    const messages = injectEphemeralUserContext(
      [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
      "<available_skills></available_skills>",
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content[0]).toMatchObject({
      type: "text",
      text: "<available_skills></available_skills>",
    });
    expect(messages[1]?.content[0]).toMatchObject({ type: "text", text: "hello" });
  });
});

describe("isEphemeralUserMessage", () => {
  it("matches user messages whose text is model-only context", () => {
    expect(
      isEphemeralUserMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: "<available_skills><skill name=\"x\">y</skill></available_skills>",
          },
        ],
      }),
    ).toBe(true);
    expect(
      isEphemeralUserMessage({
        role: "user",
        content: [{ type: "text", text: "real question" }],
      }),
    ).toBe(false);
  });
});
