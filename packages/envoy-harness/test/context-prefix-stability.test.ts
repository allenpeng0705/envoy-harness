/**
 * Prompt-cache invariants.
 *
 * Provider prefix caching only pays off if each request is a **strict
 * prefix-extension** of the one before it. envoy violated that: the
 * ephemeral turn context was spliced in *before* the trailing user
 * message, so consecutive requests diverged at message index 1 and the
 * longest common prefix was the system prompt alone — the whole
 * transcript was re-billed every turn.
 *
 * These tests pin the property directly (the analogue of codex's
 * `prefixes_context_and_instructions_once_and_consistently_across_requests`),
 * and pin the disjoint cache-token accounting that makes the hit rate
 * observable.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  InMemorySession,
  ToolRegistry,
  injectEphemeralUserContext,
  isEphemeralUserContextText,
  newSessionId,
  openAiUsage,
  type CompleteInput,
  type Message,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.js";

/** A recording adapter: captures every request the loop makes. */
function recordingModel(replies: string[]): {
  adapter: ModelAdapter;
  requests: CompleteInput[];
} {
  const requests: CompleteInput[] = [];
  let index = 0;
  const adapter: ModelAdapter = {
    async complete(input: CompleteInput): Promise<ModelResponse> {
      requests.push({
        ...input,
        messages: [...input.messages],
      });
      const text = replies[Math.min(index, replies.length - 1)] ?? "ok";
      index += 1;
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  return { adapter, requests };
}

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

describe("injectEphemeralUserContext", () => {
  it("appends after the trailing user message (prefix-preserving)", () => {
    const messages: Message[] = [userMessage("hello")];
    const out = injectEphemeralUserContext(messages, "<available_skills/>");
    expect(out).toHaveLength(2);
    expect(textOf(out[0]!)).toBe("hello");
    expect(textOf(out[1]!)).toBe("<available_skills/>");
  });

  it("does not mutate the input array", () => {
    const messages: Message[] = [userMessage("hello")];
    injectEphemeralUserContext(messages, "ctx");
    expect(messages).toHaveLength(1);
  });

  it("is a no-op for empty context", () => {
    const messages: Message[] = [userMessage("hello")];
    expect(injectEphemeralUserContext(messages, "")).toEqual(messages);
  });

  it("keeps earlier messages byte-identical", () => {
    const messages: Message[] = [
      userMessage("one"),
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      userMessage("three"),
    ];
    const before = JSON.stringify(messages);
    injectEphemeralUserContext(messages, "ctx");
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("produces a strict prefix-extension across turns", () => {
    // Simulate two turns: the second request must begin with exactly
    // the first request's messages.
    const turn1 = injectEphemeralUserContext([userMessage("first")], "EPH1");
    const history = [
      ...turn1,
      { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
      userMessage("second"),
    ];
    const turn2 = injectEphemeralUserContext(history, "EPH2");

    expect(turn2.length).toBeGreaterThan(turn1.length);
    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
  });
});

describe("the agent loop keeps every request a prefix-extension", () => {
  it("request N+1 starts with request N verbatim", async () => {
    const { adapter, requests } = recordingModel(["first reply", "second reply"]);
    const session = new InMemorySession(newSessionId(), {
      cwd: process.cwd(),
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: adapter,
      tools: new ToolRegistry(),
      session,
      cwd: process.cwd(),
      systemPrompt: "You are a test agent.",
      maxIterations: 4,
    });

    await agent.run("turn one");
    await agent.run("turn two");

    expect(requests.length).toBe(2);
    const first = requests[0]!;
    const second = requests[1]!;
    expect(second.messages.length).toBeGreaterThan(first.messages.length);
    // The prefix is identical *by value*, so a provider's prefix cache
    // can match it byte-for-byte.
    expect(JSON.stringify(second.messages.slice(0, first.messages.length))).toBe(
      JSON.stringify(first.messages),
    );
  });

  it("pins a stable prompt cache key per session", async () => {
    const { adapter, requests } = recordingModel(["a", "b"]);
    const sessionId = newSessionId();
    const session = new InMemorySession(sessionId, {
      cwd: process.cwd(),
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: adapter,
      tools: new ToolRegistry(),
      session,
      cwd: process.cwd(),
      maxIterations: 4,
    });

    await agent.run("one");
    await agent.run("two");

    expect(requests[0]?.promptCacheKey).toBe(sessionId);
    expect(requests[1]?.promptCacheKey).toBe(sessionId);
  });
});

describe("openAiUsage — disjoint cache accounting", () => {
  it("subtracts OpenAI's cached tokens from prompt_tokens", () => {
    // prompt_tokens INCLUDES cached tokens; the harness's inputTokens
    // must not, or cached input looks free of charge and invisible.
    expect(
      openAiUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 900 },
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 });
  });

  it("accepts DeepSeek's flat cache counter", () => {
    expect(
      openAiUsage({
        prompt_tokens: 500,
        completion_tokens: 20,
        prompt_cache_hit_tokens: 480,
      }),
    ).toEqual({ inputTokens: 20, outputTokens: 20, cacheReadTokens: 480 });
  });

  it("omits the cache field when nothing was cached", () => {
    const usage = openAiUsage({ prompt_tokens: 10, completion_tokens: 2 });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect("cacheReadTokens" in usage).toBe(false);
  });

  it("never reports negative uncached input", () => {
    // Defensive: a provider that reports more cache hits than prompt
    // tokens must not produce a negative cost.
    expect(
      openAiUsage({
        prompt_tokens: 100,
        completion_tokens: 1,
        prompt_cache_hit_tokens: 250,
      }).inputTokens,
    ).toBe(0);
  });

  it("keeps the buckets disjoint and summing to the provider total", () => {
    const raw = {
      prompt_tokens: 4096,
      completion_tokens: 128,
      prompt_tokens_details: { cached_tokens: 3072 },
    };
    const usage = openAiUsage(raw);
    expect(usage.inputTokens + (usage.cacheReadTokens ?? 0)).toBe(
      raw.prompt_tokens,
    );
  });
});

describe("isEphemeralUserContextText", () => {
  it("recognizes the injected shapes so chat hosts can hide them", () => {
    expect(
      isEphemeralUserContextText("<available_skills>\n</available_skills>"),
    ).toBe(true);
    expect(isEphemeralUserContextText("ACTIVE PLAN (approved at x)")).toBe(true);
    expect(isEphemeralUserContextText("Available memories (read with x)")).toBe(true);
    expect(isEphemeralUserContextText("hello")).toBe(false);
    expect(isEphemeralUserContextText("   ")).toBe(false);
  });
});
