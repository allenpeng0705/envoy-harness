/**
 * Multimodal tool result helpers + OpenAI/Anthropic bridging.
 */

import { describe, expect, it } from "vitest";

import { messagesToOpenAI } from "../../src/llm/http.js";
import {
  isMultimodalToolContent,
  multimodalToolContentToText,
  normalizeToolResultContent,
} from "../../src/tools/multimodal.js";
import type { Message } from "../../src/tools/types.js";

describe("normalizeToolResultContent", () => {
  it("passes through multimodal images", () => {
    const mm = {
      text: "ok",
      images: [{ mimeType: "image/png", data: "AA==" }],
    };
    expect(isMultimodalToolContent(mm)).toBe(true);
    expect(normalizeToolResultContent(mm)).toEqual(mm);
  });

  it("flattens strings", () => {
    expect(normalizeToolResultContent("hi")).toEqual({
      text: "hi",
      images: [],
    });
  });
});

describe("multimodalToolContentToText", () => {
  it("annotates attached images", () => {
    const text = multimodalToolContentToText({
      text: "shot",
      images: [{ mimeType: "image/png", data: "abcd" }],
    });
    expect(text).toContain("shot");
    expect(text).toContain("attached for vision");
  });
});

describe("messagesToOpenAI tool images", () => {
  it("emits tool text plus a follow-up user vision message", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_1",
            name: "device_screenshot",
            args: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_1",
            isError: false,
            content: {
              text: "Screenshot",
              images: [{ mimeType: "image/png", data: "qq" }],
            },
          },
        ],
      },
    ];
    const out = messagesToOpenAI(messages);
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg?.role).toBe("tool");
    if (toolMsg?.role === "tool") {
      expect(toolMsg.content).toContain("Screenshot");
      expect(toolMsg.content).toContain("attached for vision");
    }
    const vision = out.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === "image_url"),
    );
    expect(vision).toBeDefined();
  });
});
