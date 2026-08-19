/**
 * F7.2 tests — HTTP client abstraction + OpenAIAdapter.
 *
 * Covers:
 * 1. `zodToJsonSchema` — pure function for the simple shapes our
 *    built-in tools use (string/number/boolean/optional/default/nullable/
 *    object/array/enum) and the `{}` fallback for unsupported shapes.
 * 2. `toolsToOpenAI` / `messagesToOpenAI` — wire format translation.
 * 3. `FakeHttpClient` — request recording, FIFO queue, matchers,
 *    default response, throw on no match.
 * 4. `FetchHttpClient` — smoke test against the global `fetch` mock.
 * 5. `OpenAIAdapter` — request shape (URL, headers, body), response
 *    parsing, error handling (4xx, 5xx, malformed JSON).
 * 6. `parseChatResponse` — text-only / tool-call / usage / no-choice /
 *    stop-reason mapping / malformed tool args.
 * 7. `parseError` / `is2xx` — error formatting and 2xx classification.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  FakeHttpClient,
  FetchHttpClient,
  messagesToOpenAI,
  toolsToOpenAI,
  zodToJsonSchema,
  type HttpRequest,
  type HttpResponse,
} from "../src/llm/http.js";
import {
  is2xx,
  OpenAIAdapter,
  parseChatResponse,
  parseError,
} from "../src/llm/openai.js";
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

// ---------------------------------------------------------------------------
// zodToJsonSchema
// ---------------------------------------------------------------------------

describe("zodToJsonSchema", () => {
  it("converts z.string()", () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: "string" });
  });

  it("converts z.number()", () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" });
  });

  it("converts z.boolean()", () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" });
  });

  it("marks .optional() fields as nullable", () => {
    expect(zodToJsonSchema(z.string().optional())).toEqual({
      type: "string",
      nullable: true,
    });
  });

  it("marks .default() fields as nullable", () => {
    expect(zodToJsonSchema(z.string().default("x"))).toEqual({
      type: "string",
      nullable: true,
    });
  });

  it("marks .nullable() fields as nullable", () => {
    expect(zodToJsonSchema(z.string().nullable())).toEqual({
      type: "string",
      nullable: true,
    });
  });

  it("converts z.object with required and optional fields", () => {
    const schema = z.object({
      path: z.string(),
      offset: z.number().optional(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", nullable: true },
      },
      required: ["path"],
    });
  });

  it("omits required when every field is optional", () => {
    const schema = z.object({ note: z.string().optional() });
    const out = zodToJsonSchema(schema);
    expect(out).toEqual({
      type: "object",
      properties: { note: { type: "string", nullable: true } },
    });
    expect(out).not.toHaveProperty("required");
  });

  it("converts z.array", () => {
    expect(zodToJsonSchema(z.array(z.number()))).toEqual({
      type: "array",
      items: { type: "number" },
    });
  });

  it("converts z.enum", () => {
    expect(zodToJsonSchema(z.enum(["a", "b", "c"]))).toEqual({
      type: "string",
      enum: ["a", "b", "c"],
    });
  });

  it("falls back to {} for unsupported zod types", () => {
    // z.union is not in v0's supported set; we expect a {} fallback.
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({});
  });

  it("throws on non-zod input", () => {
    expect(() => zodToJsonSchema({ foo: "bar" })).toThrow(/not a zod schema/);
  });
});

// ---------------------------------------------------------------------------
// toolsToOpenAI
// ---------------------------------------------------------------------------

describe("toolsToOpenAI", () => {
  it("converts a single tool to OpenAI's wire format", () => {
    const tool = makeTool({
      name: "read_file",
      description: "Read a file from disk.",
      parameters: z.object({ path: z.string() }),
    });
    expect(toolsToOpenAI([tool])).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from disk.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]);
  });

  it("defaults missing description to empty string", () => {
    const tool = makeTool({
      name: "no_desc",
      description: "x", // required by Tool shape
      parameters: z.object({}),
    });
    // Override: simulate a tool with no description by passing empty.
    const t2: Tool = { ...tool, description: "" };
    const out = toolsToOpenAI([t2]);
    expect(out[0]?.function.description).toBe("");
  });

  it("returns empty array for empty input", () => {
    expect(toolsToOpenAI([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// messagesToOpenAI
// ---------------------------------------------------------------------------

describe("messagesToOpenAI", () => {
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
  function toolResult(id: string, content: unknown, isError = false): Message {
    return {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, content, isError }],
    };
  }
  function systemMsg(text: string): Message {
    return { role: "system", content: [{ type: "text", text }] };
  }

  it("passes system message through", () => {
    expect(messagesToOpenAI([systemMsg("you are helpful")])).toEqual([
      { role: "system", content: "you are helpful" },
    ]);
  });

  it("passes user message through", () => {
    expect(messagesToOpenAI([userMsg("hi")])).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("emits assistant text message with content", () => {
    expect(messagesToOpenAI([assistantText("hello")])).toEqual([
      { role: "assistant", content: "hello" },
    ]);
  });

  it("emits assistant with tool_calls and JSON-encoded arguments", () => {
    const msgs = messagesToOpenAI([
      assistantToolCall("c1", "bash", { command: "ls" }),
    ]);
    expect(msgs).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
    ]);
  });

  it("emits tool result with string content as-is", () => {
    const msgs = messagesToOpenAI([toolResult("c1", "hello")]);
    expect(msgs).toEqual([
      { role: "tool", tool_call_id: "c1", content: "hello" },
    ]);
  });

  it("emits tool result with object content as JSON string", () => {
    const msgs = messagesToOpenAI([toolResult("c1", { stdout: "x" })]);
    expect(msgs).toEqual([
      {
        role: "tool",
        tool_call_id: "c1",
        content: JSON.stringify({ stdout: "x" }),
      },
    ]);
  });

  it("omits empty system message (no text blocks)", () => {
    const msg: Message = { role: "system", content: [] };
    expect(messagesToOpenAI([msg])).toEqual([]);
  });

  it("merges multiple text blocks of an assistant message", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    expect(messagesToOpenAI([msg])).toEqual([
      { role: "assistant", content: "first\nsecond" },
    ]);
  });

  it("emits one tool message per tool result block", () => {
    const msg: Message = {
      role: "tool",
      content: [
        { type: "tool_result", toolCallId: "c1", content: "a", isError: false },
        { type: "tool_result", toolCallId: "c2", content: "b", isError: false },
      ],
    };
    expect(messagesToOpenAI([msg])).toEqual([
      { role: "tool", tool_call_id: "c1", content: "a" },
      { role: "tool", tool_call_id: "c2", content: "b" },
    ]);
  });

  it("handles a mixed transcript end-to-end", () => {
    const transcript: Message[] = [
      systemMsg("sys"),
      userMsg("hi"),
      assistantText("ok"),
      assistantToolCall("c1", "bash", { cmd: "ls" }),
      toolResult("c1", "file1\nfile2"),
    ];
    const out = messagesToOpenAI(transcript);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1]).toEqual({ role: "user", content: "hi" });
    expect(out[2]).toEqual({ role: "assistant", content: "ok" });
    expect(out[3]?.role).toBe("assistant");
    expect(out[4]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "file1\nfile2",
    });
  });
});

// ---------------------------------------------------------------------------
// FakeHttpClient
// ---------------------------------------------------------------------------

describe("FakeHttpClient", () => {
  it("records every request", async () => {
    const c = new FakeHttpClient();
    c.enqueue({ status: 200, headers: {}, body: "first" });
    c.enqueue({ status: 200, headers: {}, body: "second" });
    await c.request({ method: "GET", url: "https://x/a", headers: {}, body: "" });
    await c.request({ method: "POST", url: "https://x/b", headers: {}, body: "y" });
    expect(c.requests).toHaveLength(2);
    expect(c.requests[0]?.url).toBe("https://x/a");
    expect(c.requests[1]?.body).toBe("y");
  });

  it("drains the queue in FIFO order when no matcher is given", async () => {
    const c = new FakeHttpClient();
    c.enqueue({ status: 200, headers: {}, body: "first" });
    c.enqueue({ status: 200, headers: {}, body: "second" });
    const r1 = await c.request({ method: "GET", url: "u", headers: {}, body: "" });
    const r2 = await c.request({ method: "GET", url: "u", headers: {}, body: "" });
    expect(r1.body).toBe("first");
    expect(r2.body).toBe("second");
  });

  it("uses a match predicate to pick a queued response", async () => {
    const c = new FakeHttpClient();
    c.enqueue(
      (req: HttpRequest) => req.body.includes("special"),
      { status: 201, headers: {}, body: "matched" },
    );
    c.enqueue(
      (req: HttpRequest) => !req.body.includes("special"),
      { status: 200, headers: {}, body: "fallback" },
    );
    const a = await c.request({ method: "POST", url: "u", headers: {}, body: "special" });
    const b = await c.request({ method: "POST", url: "u", headers: {}, body: "other" });
    expect(a.body).toBe("matched");
    expect(b.body).toBe("fallback");
  });

  it("falls back to defaultResponse when no queued response matches", async () => {
    const c = new FakeHttpClient();
    c.setDefault({ status: 503, headers: {}, body: "down" });
    const r = await c.request({ method: "GET", url: "u", headers: {}, body: "" });
    expect(r.status).toBe(503);
  });

  it("throws when nothing is queued and no default is set", async () => {
    const c = new FakeHttpClient();
    await expect(
      c.request({ method: "GET", url: "u", headers: {}, body: "" }),
    ).rejects.toThrow(/no response queued/);
  });

  it("throws if enqueue is called with a matcher but no response", () => {
    const c = new FakeHttpClient();
    expect(() =>
      c.enqueue((_req: HttpRequest) => true, undefined as unknown as HttpResponse),
    ).toThrow(/response is required/);
  });
});

// ---------------------------------------------------------------------------
// FetchHttpClient — smoke test against a mocked global fetch
// ---------------------------------------------------------------------------

describe("FetchHttpClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("forwards method/url/headers/body and returns parsed response", async () => {
    const mock = vi.fn<typeof globalThis.fetch>(async () => {
      return new Response("hello world", {
        status: 200,
        headers: { "x-trace-id": "abc" },
      });
    });
    globalThis.fetch = mock;

    const c = new FetchHttpClient();
    const resp = await c.request({
      method: "POST",
      url: "https://api.example.com/v1/x",
      headers: { "Content-Type": "application/json" },
      body: '{"k":"v"}',
    });

    expect(mock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mock.mock.calls[0] ?? [];
    expect(calledUrl).toBe("https://api.example.com/v1/x");
    expect(calledInit?.method).toBe("POST");
    expect(calledInit?.body).toBe('{"k":"v"}');
    expect(resp.status).toBe(200);
    expect(resp.body).toBe("hello world");
    expect(resp.headers["x-trace-id"]).toBe("abc");
  });

  it("forwards the abort signal to fetch", async () => {
    const mock = vi.fn<typeof globalThis.fetch>(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        return new Response("ok", { status: 200 });
      },
    );
    globalThis.fetch = mock;

    const c = new FetchHttpClient();
    const controller = new AbortController();
    const p = c.request({
      method: "POST",
      url: "https://api.example.com/v1/x",
      headers: {},
      body: "{}",
      signal: controller.signal,
    });
    controller.abort();
    await p;
    const [_, calledInit] = mock.mock.calls[0] ?? [];
    // The composite signal forwarded to fetch must reflect the
    // caller's abort.
    expect(calledInit?.signal?.aborted).toBe(true);
  });

  it("aborts the request when the timeout elapses", async () => {
    const mock = vi.fn<typeof globalThis.fetch>(
      async (_url: string | URL | Request, init?: RequestInit) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
        return new Response("ok", { status: 200 });
      },
    );
    globalThis.fetch = mock;

    const c = new FetchHttpClient({ timeoutMs: 10 });
    await expect(
      c.request({
        method: "POST",
        url: "https://api.example.com/v1/x",
        headers: {},
        body: "{}",
      }),
    ).rejects.toThrow(/Abort/);
  });
});

// ---------------------------------------------------------------------------
// OpenAIAdapter — request shape
// ---------------------------------------------------------------------------

describe("OpenAIAdapter — request shape", () => {
  function setup() {
    const fake = new FakeHttpClient();
    fake.enqueue({
      status: 200,
      headers: {},
      body: JSON.stringify({
        id: "x",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "hi" },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    });
    const adapter = new OpenAIAdapter({
      apiKey: "sk-test",
      model: "gpt-4o",
      httpClient: fake,
    });
    return { fake, adapter };
  }

  it("POSTs to baseUrl + /chat/completions", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({ messages: [], tools: [] });
    expect(fake.requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("uses custom baseUrl when provided", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({
      status: 200,
      headers: {},
      body: JSON.stringify({ model: "x", choices: [] }),
    });
    const adapter = new OpenAIAdapter({
      apiKey: "k",
      model: "m",
      baseUrl: "https://proxy.example/v2",
      httpClient: fake,
    });
    await adapter.complete({ messages: [], tools: [] });
    expect(fake.requests[0]?.url).toBe("https://proxy.example/v2/chat/completions");
  });

  it("sends the right headers (auth + content-type)", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({ messages: [], tools: [] });
    const h = fake.requests[0]?.headers ?? {};
    expect(h["Authorization"]).toBe("Bearer sk-test");
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("sends organization header when configured", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({
      status: 200,
      headers: {},
      body: JSON.stringify({ model: "x", choices: [] }),
    });
    const adapter = new OpenAIAdapter({
      apiKey: "k",
      model: "m",
      organization: "org-1",
      httpClient: fake,
    });
    await adapter.complete({ messages: [], tools: [] });
    expect(fake.requests[0]?.headers["OpenAI-Organization"]).toBe("org-1");
  });

  it("body has model and messages, no tools key when empty", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    });
    const body = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body).not.toHaveProperty("tools");
  });

  it("body includes tools when provided", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({
      messages: [],
      tools: [
        makeTool({
          name: "read_file",
          description: "Read.",
          parameters: z.object({ path: z.string() }),
        }),
      ],
    });
    const body = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]);
  });

  it("body includes temperature and max_tokens when set", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({
      messages: [],
      tools: [],
      temperature: 0.3,
      maxTokens: 256,
    });
    const body = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(256);
  });

  it("body omits temperature/max_tokens when unset", async () => {
    const { fake, adapter } = setup();
    await adapter.complete({ messages: [], tools: [] });
    const body = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_tokens");
  });
});

// ---------------------------------------------------------------------------
// OpenAIAdapter — error handling
// ---------------------------------------------------------------------------

describe("OpenAIAdapter — error handling", () => {
  it("throws on 4xx with the error message from JSON body", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({
      status: 401,
      headers: {},
      body: JSON.stringify({ error: { message: "bad key" } }),
    });
    const adapter = new OpenAIAdapter({
      apiKey: "k",
      model: "m",
      httpClient: fake,
    });
    await expect(adapter.complete({ messages: [], tools: [] })).rejects.toThrow(
      /OpenAI API error \(401\): bad key/,
    );
  });

  it("throws on 5xx with the error message", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({
      status: 503,
      headers: {},
      body: JSON.stringify({ error: { message: "down" } }),
    });
    const adapter = new OpenAIAdapter({
      apiKey: "k",
      model: "m",
      httpClient: fake,
    });
    await expect(adapter.complete({ messages: [], tools: [] })).rejects.toThrow(
      /OpenAI API error \(503\): down/,
    );
  });

  it("falls back to body slice when error body is not JSON", async () => {
    const fake = new FakeHttpClient();
    fake.enqueue({ status: 500, headers: {}, body: "<html>nope</html>" });
    const adapter = new OpenAIAdapter({
      apiKey: "k",
      model: "m",
      httpClient: fake,
    });
    await expect(adapter.complete({ messages: [], tools: [] })).rejects.toThrow(
      /OpenAI API error \(500\): <html>nope/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseChatResponse
// ---------------------------------------------------------------------------

describe("parseChatResponse", () => {
  it("maps a text-only response to a text content block", () => {
    const r = parseChatResponse({
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "hi" },
        },
      ],
    });
    expect(r.content).toEqual([{ type: "text", text: "hi" }]);
    expect(r.stopReason).toBe("end_turn");
    expect(r.model).toBe("gpt-4o");
  });

  it("maps a tool-call response to a tool_call content block", () => {
    const r = parseChatResponse({
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "bash", arguments: '{"command":"ls"}' },
              },
            ],
          },
        },
      ],
    });
    expect(r.content).toEqual([
      { type: "tool_call", id: "c1", name: "bash", args: { command: "ls" } },
    ]);
    expect(r.stopReason).toBe("tool_use");
  });

  it("maps usage to ModelResponse.usage when present", () => {
    const r = parseChatResponse({
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "" },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("omits usage when not in payload", () => {
    const r = parseChatResponse({
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "" },
        },
      ],
    });
    expect(r.usage).toBeUndefined();
  });

  it("returns empty content when there are no choices", () => {
    const r = parseChatResponse({ model: "x", choices: [] });
    expect(r.content).toEqual([]);
    expect(r.stopReason).toBe("end_turn");
  });

  it("maps finish_reason length to max_tokens", () => {
    const r = parseChatResponse({
      model: "x",
      choices: [
        {
          index: 0,
          finish_reason: "length",
          message: { role: "assistant", content: "..." },
        },
      ],
    });
    expect(r.stopReason).toBe("max_tokens");
  });

  it("maps finish_reason content_filter to stop_sequence", () => {
    const r = parseChatResponse({
      model: "x",
      choices: [
        {
          index: 0,
          finish_reason: "content_filter",
          message: { role: "assistant", content: "" },
        },
      ],
    });
    expect(r.stopReason).toBe("stop_sequence");
  });

  it("maps finish_reason function_call to end_turn", () => {
    const r = parseChatResponse({
      model: "x",
      choices: [
        {
          index: 0,
          finish_reason: "function_call",
          message: { role: "assistant", content: "ok" },
        },
      ],
    });
    expect(r.stopReason).toBe("end_turn");
  });

  it("leaves args as {} when tool call arguments are not valid JSON", () => {
    const r = parseChatResponse({
      model: "x",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "x", arguments: "not-json" },
              },
            ],
          },
        },
      ],
    });
    const block = r.content[0];
    expect(block?.type).toBe("tool_call");
    if (block?.type === "tool_call") {
      expect(block.args).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// parseError
// ---------------------------------------------------------------------------

describe("parseError", () => {
  const resp = (status: number, body: string): HttpResponse => ({
    status,
    headers: {},
    body,
  });

  it("uses the JSON error.message when available", () => {
    expect(
      parseError(resp(429, JSON.stringify({ error: { message: "rate limited" } }))),
    ).toBe("OpenAI API error (429): rate limited");
  });

  it("falls back to a 200-char body slice when not JSON", () => {
    const body = "<html>oh no</html>";
    expect(parseError(resp(500, body))).toBe(
      "OpenAI API error (500): <html>oh no</html>",
    );
  });

  it("falls back when JSON has no error field", () => {
    expect(parseError(resp(500, JSON.stringify({ status: "down" })))).toBe(
      'OpenAI API error (500): {"status":"down"}',
    );
  });

  it("truncates very long non-JSON bodies to 200 chars", () => {
    const long = "x".repeat(500);
    const out = parseError(resp(500, long));
    expect(out).toMatch(/^OpenAI API error \(500\): x{200}$/);
  });
});

// ---------------------------------------------------------------------------
// is2xx
// ---------------------------------------------------------------------------

describe("is2xx", () => {
  it("classifies 2xx as true", () => {
    expect(is2xx(200)).toBe(true);
    expect(is2xx(201)).toBe(true);
    expect(is2xx(204)).toBe(true);
    expect(is2xx(299)).toBe(true);
  });

  it("classifies 1xx, 3xx, 4xx, 5xx as false", () => {
    expect(is2xx(100)).toBe(false);
    expect(is2xx(199)).toBe(false);
    expect(is2xx(300)).toBe(false);
    expect(is2xx(301)).toBe(false);
    expect(is2xx(400)).toBe(false);
    expect(is2xx(404)).toBe(false);
    expect(is2xx(500)).toBe(false);
    expect(is2xx(503)).toBe(false);
  });
});
