/**
 * Wave 1 — remoteCompact on LLM adapters.
 */

import { describe, expect, it } from "vitest";

import { OpenAIAdapter } from "../src/llm/openai.js";
import { FakeHttpClient } from "../src/llm/http.js";

describe("OpenAIAdapter.remoteCompact", () => {
  it("summarizes via complete()", async () => {
    const http = new FakeHttpClient();
    http.enqueue({
      status: 200,
      headers: {},
      body: JSON.stringify({
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Summary: decided to use TypeScript.",
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    const adapter = new OpenAIAdapter({
      apiKey: "test",
      model: "gpt-4o-mini",
      httpClient: http,
    });
    const out = await adapter.remoteCompact({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "use TypeScript" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      ],
    });
    expect(out.summary).toMatch(/TypeScript/);
  });
});
