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
  it("appends ephemeral context AFTER the trailing user prompt", () => {
    // Appending (rather than splicing in front of the prompt) is what
    // keeps every request a strict prefix-extension of its predecessor,
    // so provider prefix caching can actually hit. See
    // `test/context-prefix-stability.test.ts`.
    const messages = injectEphemeralUserContext(
      [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
      "<available_skills></available_skills>",
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content[0]).toMatchObject({ type: "text", text: "hello" });
    expect(messages[1]?.content[0]).toMatchObject({
      type: "text",
      text: "<available_skills></available_skills>",
    });
  });

  it("leaves earlier messages untouched (prefix stability)", () => {
    const history = [
      { role: "user" as const, content: [{ type: "text" as const, text: "one" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "two" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "three" }] },
    ];
    const before = JSON.stringify(history);
    injectEphemeralUserContext(history, "ctx");
    expect(JSON.stringify(history)).toBe(before);
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
