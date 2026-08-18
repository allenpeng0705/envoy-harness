/**
 * F7.3 tests — AnthropicAdapter.
 *
 * Covers:
 * 1. `splitSystemAndMessages` — extract the system prompt,
 *    concatenate multiple system blocks, preserve order.
 * 2. `toolsToAnthropic` — flat `{ name, description,
 *    input_schema }` (no `function` wrapper).
 * 3. `messagesToAnthropic` — user text → `user: string`,
 *    tool results → `user: tool_result[]`, assistant text +
 *    tool calls → `assistant: content[]` (mixed in one array),
 *    empty assistant content → placeholder.
 * 4. `parseMessagesResponse` — text-only / tool-use / mixed
 *    content; usage mapping; stop-reason mapping (all four
 *    + null + undefined); no-content guard.
 * 5. `parseError` / `is2xx` — error formatting, 2xx
 *    classification.
 * 6. `AnthropicAdapter` request shape — URL, headers
 *    (x-api-key, anthropic-version, content-type), body
 *    (model, max_tokens default + override, system, tools,
 *    temperature).
 * 7. `AnthropicAdapter` error handling — 4xx / 5xx JSON,
 *    non-JSON body.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeHttpClient } from "../src/llm/http.js";
import {
  AnthropicAdapter,
  is2xx,
  messagesToAnthropic,
  parseError,
  parseMessagesResponse,
  splitSystemAndMessages,
  toolsToAnthropic,
} from "../src/llm/anthropic.js";
import type { HttpResponse } from "../src/llm/http.js";
import type { Message, Tool } from "../src/tools/types.js";

/** Build a minimal Tool for tests. */
function makeTool(overrides: Partial<Tool> & Pick<Tool, "name" | "parameters">): Tool {
  return {
    description: `desc for ${overrides.name}`,
    async execute(_args, _ctx) {
      return { content: "ok" };
    },
    ...overrides,
  };
}

/** A canned success response body for Anthropic's `/v1/messages`. */
function okResponse(
  overrides: {
    text?: string;
    toolUse?: { id: string; name: string; input: Record<string, unknown> };
    stopReason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
    inputTokens?: number;
    outputTokens?: number;
  } = {},
): string {
  const content: Array<Record<string, unknown>> = [];
  if (overrides.text !== undefined) {
    content.push({ type: "text", text: overrides.text });
  }
  if (overrides.toolUse) {
    content.push({ type: "tool_use", ...overrides.toolUse });
  }
  const body: Record<string, unknown> = {
    id: "msg_test",
    model: "claude-sonnet-4-6",
    stop_reason: overrides.stopReason ?? "end_turn",
    content,
  };
  if (overrides.inputTokens !== undefined || overrides.outputTokens !== undefined) {
    body.usage = {
      input_tokens: overrides.inputTokens ?? 0,
      output_tokens: overrides.outputTokens ?? 0,
    };
  }
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------
// splitSystemAndMessages
// ---------------------------------------------------------------------------

describe("splitSystemAndMessages", () => {
  it("returns empty system and empty messages for empty input", () => {
    expect(splitSystemAndMessages([])).toEqual({ system: "", messages: [] });
  });

  it("extracts a single system message and returns the rest", () => {
    const sys: Message = { role: "system", content: [{ type: "text", text: "you are helpful" }] };
    const user: Message = { role: "user", content: [{ type: "text", text: "hi" }] };
    const out = splitSystemAndMessages([sys, user]);
    expect(out.system).toBe("you are helpful");
    expect(out.messages).toEqual([user]);
  });

  it("joins multiple system messages with a blank line", () => {
    const a: Message = { role: "system", content: [{ type: "text", text: "first" }] };
    const b: Message = { role: "system", content: [{ type: "text", text: "second" }] };
    const out = splitSystemAndMessages([a, b]);
    expect(out.system).toBe("first\n\nsecond");
    expect(out.messages).toEqual([]);
  });

  it("preserves non-system messages in original order", () => {
    const sys: Message = { role: "system", content: [{ type: "text", text: "s" }] };
    const u1: Message = { role: "user", content: [{ type: "text", text: "u1" }] };
    const a1: Message = { role: "assistant", content: [{ type: "text", text: "a1" }] };
    const u2: Message = { role: "user", content: [{ type: "text", text: "u2" }] };
    const out = splitSystemAndMessages([sys, u1, a1, u2]);
    expect(out.system).toBe("s");
    expect(out.messages).toEqual([u1, a1, u2]);
  });

  it("returns empty system when system message has no text blocks", () => {
    const sys: Message = { role: "system", content: [] };
    const user: Message = { role: "user", content: [{ type: "text", text: "hi" }] };
    const out = splitSystemAndMessages([sys, user]);
    expect(out.system).toBe("");
    expect(out.messages).toEqual([user]);
  });
});

// ---------------------------------------------------------------------------
// toolsToAnthropic
// ---------------------------------------------------------------------------

describe("toolsToAnthropic", () => {
  it("converts a tool to Anthropic's flat wire format", () => {
    const tool = makeTool({
      name: "bash",
      description: "Run a shell command.",
      parameters: z.object({ command: z.string() }),
    });
    const out = toolsToAnthropic([tool]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      name: "bash",
      description: "Run a shell command.",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    });
    // Anthropic has no `function` wrapper.
    expect((out[0] as unknown as { type?: string }).type).toBeUndefined();
  });

  it("defaults missing description to empty string", () => {
    const tool = makeTool({
      name: "no_desc",
      description: "",
      parameters: z.object({}),
    });
    const out = toolsToAnthropic([tool]);
    expect(out[0]?.description).toBe("");
  });

  it("returns empty array for empty input", () => {
    expect(toolsToAnthropic([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// messagesToAnthropic
// ---------------------------------------------------------------------------

describe("messagesToAnthropic", () => {
  function userMsg(text: string): Message {
    return { role: "user", content: [{ type: "text", text }] };
  }
  function assistantText(text: string): Message {
    return { role: "assistant", content: [{ type: "text", text }] };
  }
  function assistantToolCall(id: string, name: string, args: unknown): Message {
    return {
      role: "assistant",
      content: [{ type: "tool_call", id, name, args }],
    };
  }
  function toolResult(id: string, content: unknown): Message {
    return {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, content, isError: false }],
    };
  }

  it("emits user text as role: user, content: string", () => {
    expect(messagesToAnthropic([userMsg("hi")])).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("emits assistant text as role: assistant, content: [text block]", () => {
    expect(messagesToAnthropic([assistantText("hello")])).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    ]);
  });

  it("emits assistant tool call as content: [tool_use block]", () => {
    expect(
      messagesToAnthropic([assistantToolCall("t1", "bash", { command: "ls" })]),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      },
    ]);
  });

  it("merges assistant text + tool call into a single content array", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_call", id: "t1", name: "bash", args: { command: "ls" } },
      ],
    };
    expect(messagesToAnthropic([msg])).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        ],
      },
    ]);
  });

  it("emits a placeholder when assistant content is empty", () => {
    const msg: Message = { role: "assistant", content: [] };
    expect(messagesToAnthropic([msg])).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    ]);
  });

  it("emits a tool message as user with tool_result block", () => {
    expect(
      messagesToAnthropic([toolResult("t1", "file1\nfile2")]),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file1\nfile2" }],
      },
    ]);
  });

  it("JSON-stringifies non-string tool result content", () => {
    const msg: Message = {
      role: "tool",
      content: [
        { type: "tool_result", toolCallId: "t1", content: { stdout: "x" }, isError: false },
      ],
    };
    expect(messagesToAnthropic([msg])).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: JSON.stringify({ stdout: "x" }),
          },
        ],
      },
    ]);
  });

  it("emits multiple tool results in one user message", () => {
    const msg: Message = {
      role: "tool",
      content: [
        { type: "tool_result", toolCallId: "t1", content: "a", isError: false },
        { type: "tool_result", toolCallId: "t2", content: "b", isError: false },
      ],
    };
    expect(messagesToAnthropic([msg])).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "a" },
          { type: "tool_result", tool_use_id: "t2", content: "b" },
        ],
      },
    ]);
  });

  it("emits a user message with text + tool results as two wire messages", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "text", text: "see above" },
        { type: "tool_result", toolCallId: "t1", content: "result", isError: false },
      ],
    };
    expect(messagesToAnthropic([msg])).toEqual([
      { role: "user", content: "see above" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }],
      },
    ]);
  });

  it("handles a full harness transcript", () => {
    const sys: Message = { role: "system", content: [{ type: "text", text: "s" }] };
    const u1 = userMsg("hi");
    const a1 = assistantText("ok");
    const a2 = assistantToolCall("t1", "bash", { command: "ls" });
    const tr = toolResult("t1", "file1");
    const a3 = assistantText("done");
    // The system message is stripped by splitSystemAndMessages first.
    const split = splitSystemAndMessages([sys, u1, a1, a2, tr, a3]);
    const out = messagesToAnthropic(split.messages);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ role: "user", content: "hi" });
    expect(out[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    expect(out[2]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
      ],
    });
    expect(out[3]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file1" }],
    });
    expect(out[4]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
  });
});

// ---------------------------------------------------------------------------
// parseMessagesResponse
// ---------------------------------------------------------------------------

describe("parseMessagesResponse", () => {
  it("maps text-only response to a text content block", () => {
    const r = parseMessagesResponse({
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hi" }],
    });
    expect(r.content).toEqual([{ type: "text", text: "hi" }]);
    expect(r.stopReason).toBe("end_turn");
    expect(r.model).toBe("claude-sonnet-4-6");
  });

  it("maps a tool_use response to a tool_call content block", () => {
    const r = parseMessagesResponse({
      model: "claude-sonnet-4-6",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "bash",
          input: { command: "ls" },
        },
      ],
    });
    expect(r.content).toEqual([
      { type: "tool_call", id: "t1", name: "bash", args: { command: "ls" } },
    ]);
    expect(r.stopReason).toBe("tool_use");
  });

  it("preserves order of mixed text + tool_use blocks", () => {
    const r = parseMessagesResponse({
      model: "claude-sonnet-4-6",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "t1", name: "bash", input: {} },
      ],
    });
    expect(r.content).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool_call", id: "t1", name: "bash", args: {} },
    ]);
  });

  it("maps input_tokens / output_tokens to ModelResponse.usage", () => {
    const r = parseMessagesResponse({
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("omits usage when not in payload", () => {
    const r = parseMessagesResponse({
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "" }],
    });
    expect(r.usage).toBeUndefined();
  });

  it("returns empty content when response has no content", () => {
    const r = parseMessagesResponse({
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      content: [],
    });
    expect(r.content).toEqual([]);
  });

  it("maps stop_reason max_tokens", () => {
    const r = parseMessagesResponse({
      model: "claude-sonnet-4-6",
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "..." }],
    });
    expect(r.stopReason).toBe("max_tokens");
  });

  it("maps stop_reason stop_sequence", () => {
    const r = parseMessagesResponse({
      model: "claude-sonnet-4-6",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "" }],
    });
    expect(r.stopReason).toBe("stop_sequence");
  });

  it("maps stop_reason null to end_turn", () => {
    const r = parseMessagesResponse({
      model: "claude-sonnet-4-6",
      stop_reason: null,
      content: [],
    });
    expect(r.stopReason).toBe("end_turn");
  });
});

// ---------------------------------------------------------------------------
// parseError / is2xx
// ---------------------------------------------------------------------------

describe("parseError", () => {
  const resp = (status: number, body: string): HttpResponse => ({
    status,
    headers: {},
    body,
  });

  it("uses the JSON error.message when available", () => {
    expect(
      parseError(resp(401, JSON.stringify({ error: { message: "bad key" } }))),
    ).toBe("Anthropic API error (401): bad key");
  });

  it("falls back to a 200-char body slice when not JSON", () => {
    expect(parseError(resp(500, "<html>nope</html>"))).toBe(
      "Anthropic API error (500): <html>nope</html>",
    );
  });

  it("falls back when JSON has no error field", () => {
    expect(parseError(resp(500, JSON.stringify({ status: "down" })))).toBe(
      'Anthropic API error (500): {"status":"down"}',
    );
  });

  it("truncates very long non-JSON bodies to 200 chars", () => {
    const long = "x".repeat(500);
    const out = parseError(resp(500, long));
    expect(out).toMatch(/^Anthropic API error \(500\): x{200}$/);
  });
});

describe("is2xx", () => {
  it("classifies 2xx as true", () => {
    expect(is2xx(200)).toBe(true);
    expect(is2xx(201)).toBe(true);
    expect(is2xx(299)).toBe(true);
  });

  it("classifies non-2xx as false", () => {
    expect(is2xx(199)).toBe(false);
    expect(is2xx(300)).toBe(false);
    expect(is2xx(400)).toBe(false);
    expect(is2xx(500)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AnthropicAdapter — request shape
// ---------------------------------------------------------------------------

describe("AnthropicAdapter — request shape", () => {
  function setup(overrides: { text?: string; stopReason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" } = {}) {
    const fake = new FakeHttpClient();
    fake.enqueue({
      status: 200,
      headers: {},
      body: okResponse({ text: overrides.text ?? "hi", stopReason: overrides.stopReason ?? "end_turn" }),
    });
    const adapter = new AnthropicAdapter({
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      httpClient: fake,
    });
    return { fake, adapter };
  }

  it("POSTs to baseUrl + /v1/messages", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({ messages: [], tools: [] });
    expect(fake.requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("uses custom baseUrl when provided", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 200, headers: {}, body: okResponse() });
    const adapter = new AnthropicAdapter({
      apiKey: "k",
      model: "m",
      baseUrl: "https://proxy.example",
      httpClient: fake,
    });
    await adapter.complete({ messages: [], tools: [] });
    expect(fake.requests[0]?.url).toBe("https://proxy.example/v1/messages");
  });

  it("sends x-api-key, anthropic-version, and Content-Type headers", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({ messages: [], tools: [] });
    const h = fake.requests[0]?.headers ?? {};
    expect(h["x-api-key"]).toBe("sk-test");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("respects a custom anthropic-version", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 200, headers: {}, body: okResponse() });
    const adapter = new AnthropicAdapter({
      apiKey: "k",
      model: "m",
      anthropicVersion: "2024-01-01",
      httpClient: fake,
    });
    await adapter.complete({ messages: [], tools: [] });
    expect(fake.requests[0]?.headers["anthropic-version"]).toBe("2024-01-01");
  });

  it("body has model, max_tokens=1024 default, no system when absent", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({ messages: [], tools: [] });
    const body = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(1024);
    expect(body).not.toHaveProperty("system");
  });

  it("body has system when present in messages", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({
      messages: [
        { role: "system", content: [{ type: "text", text: "you are helpful" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      tools: [],
    });
    const body = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(body.system).toBe("you are helpful");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("body has tools in flat format (no function wrapper) when present", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({
      messages: [],
      tools: [
        makeTool({
          name: "bash",
          description: "Run.",
          parameters: z.object({ command: z.string() }),
        }),
      ],
    });
    const body = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(body.tools).toEqual([
      {
        name: "bash",
        description: "Run.",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ]);
  });

  it("body has temperature when set, omits when unset", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 200, headers: {}, body: okResponse() });
    fake.enqueue({ status: 200, headers: {}, body: okResponse() });
    const adapter = new AnthropicAdapter({
      apiKey: "k",
      model: "m",
      httpClient: fake,
    });
    await adapter.complete({ messages: [], tools: [], temperature: 0.7 });
    await adapter.complete({ messages: [], tools: [] });
    const bodyWith = JSON.parse(fake.requests[0]?.body ?? "{}");
    const bodyWithout = JSON.parse(fake.requests[1]?.body ?? "{}");
    expect(bodyWith.temperature).toBe(0.7);
    expect(bodyWithout).not.toHaveProperty("temperature");
  });

  it("body uses caller's max_tokens override", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({ messages: [], tools: [], maxTokens: 256 });
    const body = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(body.max_tokens).toBe(256);
  });
});

// ---------------------------------------------------------------------------
// AnthropicAdapter — error handling
// ---------------------------------------------------------------------------

describe("AnthropicAdapter — error handling", () => {
  it("throws on 4xx with the error message from JSON body", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({
      status: 401,
      headers: {},
      body: JSON.stringify({ error: { message: "bad key" } }),
    });
    const adapter = new AnthropicAdapter({
      apiKey: "k",
      model: "m",
      httpClient: fake,
    });
    await expect(adapter.complete({ messages: [], tools: [] })).rejects.toThrow(
      /Anthropic API error \(401\): bad key/,
    );
  });

  it("throws on 5xx with the error message", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({
      status: 503,
      headers: {},
      body: JSON.stringify({ error: { message: "overloaded" } }),
    });
    const adapter = new AnthropicAdapter({
      apiKey: "k",
      model: "m",
      httpClient: fake,
    });
    await expect(adapter.complete({ messages: [], tools: [] })).rejects.toThrow(
      /Anthropic API error \(503\): overloaded/,
    );
  });

  it("falls back to body slice when error body is not JSON", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 500, headers: {}, body: "<html>oh no</html>" });
    const adapter = new AnthropicAdapter({
      apiKey: "k",
      model: "m",
      httpClient: fake,
    });
    await expect(adapter.complete({ messages: [], tools: [] })).rejects.toThrow(
      /Anthropic API error \(500\): <html>oh no/,
    );
  });
});
