/**
 * F7.4 tests — DeepSeekAdapter.
 *
 * DeepSeek's API is OpenAI-compatible. The adapter is a
 * thin constructor wrapper that sets the DeepSeek baseUrl
 * and default model. The wire format, response parsing,
 * error handling, and stop-reason mapping come from
 * `OpenAIAdapter` (already tested in F7.2).
 *
 * What this file covers:
 * 1. Default URL + default model.
 * 2. Custom model override.
 * 3. Custom baseUrl override.
 * 4. Custom httpClient pass-through.
 * 5. End-to-end: the request reaches the DeepSeek base URL
 *    with the right body shape (OpenAI-compatible).
 * 6. Response parsing: stop reason mapping + usage mapping
 *    (regression test that the subclass doesn't break
 *    OpenAI's response parser).
 */

import { describe, expect, it } from "vitest";

import { FakeHttpClient } from "../src/llm/http.js";
import { DeepSeekAdapter } from "../src/llm/deepseek.js";

function okResponse(text = "hi", stopReason: "stop" | "tool_calls" | "length" = "stop"): string {
  return JSON.stringify({
    id: "x",
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        finish_reason: stopReason,
        message: { role: "assistant", content: text },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });
}

// ---------------------------------------------------------------------------
// Defaults + overrides
// ---------------------------------------------------------------------------

describe("DeepSeekAdapter — defaults", () => {
  it("POSTs to https://api.deepseek.com/v1/chat/completions by default", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 200, headers: {}, body: okResponse() });
    const adapter = new DeepSeekAdapter({
      apiKey: "sk-test",
      httpClient: fake,
    });
    await adapter.complete({ messages: [], tools: [] });
    expect(fake.requests[0]?.url).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });

  it("uses 'deepseek-chat' as the default model", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 200, headers: {}, body: okResponse() });
    const adapter = new DeepSeekAdapter({
      apiKey: "sk-test",
      httpClient: fake,
    });
    await adapter.complete({ messages: [], tools: [] });
    const body = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(body.model).toBe("deepseek-chat");
  });
});

describe("DeepSeekAdapter — overrides", () => {
  it("respects a custom model (e.g. deepseek-reasoner)", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 200, headers: {}, body: okResponse() });
    const adapter = new DeepSeekAdapter({
      apiKey: "sk-test",
      model: "deepseek-reasoner",
      httpClient: fake,
    });
    await adapter.complete({ messages: [], tools: [] });
    const body = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(body.model).toBe("deepseek-reasoner");
  });

  it("respects a custom baseUrl", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 200, headers: {}, body: okResponse() });
    const adapter = new DeepSeekAdapter({
      apiKey: "sk-test",
      baseUrl: "https://proxy.example/v3",
      httpClient: fake,
    });
    await adapter.complete({ messages: [], tools: [] });
    expect(fake.requests[0]?.url).toBe(
      "https://proxy.example/v3/chat/completions",
    );
  });

  it("sends the right headers (Bearer auth, Content-Type)", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 200, headers: {}, body: okResponse() });
    const adapter = new DeepSeekAdapter({
      apiKey: "sk-test",
      httpClient: fake,
    });
    await adapter.complete({ messages: [], tools: [] });
    const h = fake.requests[0]?.headers ?? {};
    expect(h["Authorization"]).toBe("Bearer sk-test");
    expect(h["Content-Type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: response parsing (regression — subclass doesn't break OpenAI)
// ---------------------------------------------------------------------------

describe("DeepSeekAdapter — response parsing", () => {
  it("parses a text-only response", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 200, headers: {}, body: okResponse("hello") });
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      httpClient: fake,
    });
    const r = await adapter.complete({ messages: [], tools: [] });
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.stopReason).toBe("end_turn");
    expect(r.model).toBe("deepseek-chat");
  });

  it("parses usage into ModelResponse.usage", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 200, headers: {}, body: okResponse() });
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      httpClient: fake,
    });
    const r = await adapter.complete({ messages: [], tools: [] });
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it("maps finish_reason tool_calls to stopReason tool_use", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({
      status: 200,
      headers: {},
      body: JSON.stringify({
        model: "deepseek-chat",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "t1",
                  type: "function",
                  function: { name: "bash", arguments: '{"command":"ls"}' },
                },
              ],
            },
          },
        ],
      }),
    });
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      httpClient: fake,
    });
    const r = await adapter.complete({ messages: [], tools: [] });
    expect(r.stopReason).toBe("tool_use");
    expect(r.content).toEqual([
      { type: "tool_call", id: "t1", name: "bash", args: { command: "ls" } },
    ]);
  });

  it("throws on 4xx with a parseError message", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({
      status: 401,
      headers: {},
      body: JSON.stringify({ error: { message: "bad key" } }),
    });
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      httpClient: fake,
    });
    await expect(adapter.complete({ messages: [], tools: [] })).rejects.toThrow(
      /OpenAI API error \(401\): bad key/,
    );
  });
});
