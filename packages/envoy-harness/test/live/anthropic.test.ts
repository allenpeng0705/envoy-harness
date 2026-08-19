/**
 * Anthropic live tests (T3.6).
 *
 * **What this file tests:** the real network round-trip
 * for `AnthropicAdapter` via `createProviderAdapter`. The
 * hermetic suite (`test/llm-anthropic.test.ts`) covers
 * the wire shape via `FakeHttpClient`; this file covers
 * "the request actually returns a valid response from
 * `api.anthropic.com`" — the wiring that hermetic tests
 * can't see.
 *
 * **Opt-in:** runs only when BOTH `RUN_LIVE_TESTS=1` AND
 * `ANTHROPIC_API_KEY` are set. See `./helpers.ts` for the
 * gate. CI does not set either; developers run via
 * `pnpm test:live`.
 *
 * **What it does NOT test:** multi-turn, tool use,
 * streaming, system-prompt composition. The hermetic
 * suite covers those. This file is the "smoke against
 * the real API" lane.
 *
 * **Cost:** one short completion per run (~1k input +
 * ~5 output tokens). Anthropic charges per token; this
 * is pennies per run. Don't loop it.
 *
 * **Anthropic specifics:** the system prompt is required
 * by the API and lives in a separate `system` field, not
 * in the messages array. The adapter handles that
 * translation; this test confirms the end-to-end shape.
 */

import { expect, it } from "vitest";

import { createProviderAdapter } from "../../src/llm/index.js";

import { liveDescribe } from "./helpers.js";

liveDescribe("Anthropic live — simple completion", "ANTHROPIC_API_KEY", () => {
  it(
    "completes a one-line prompt and reports usage",
    async () => {
      const adapter = createProviderAdapter({ provider: "anthropic" });
      const result = await adapter.complete({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Reply with just the single word: pong",
              },
            ],
          },
        ],
        tools: [],
      });
      expect(result.stopReason).toBe("end_turn");
      // The model should produce at least one text block.
      const text = result.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
      expect(text.toLowerCase()).toContain("pong");
      // Usage: hermetic tests don't enforce the API key
      // round-trip, so the live lane is the place that
      // catches "the model returned usage that the cost
      // tracker can price".
      expect(result.usage).toBeDefined();
      expect(result.usage?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(result.usage?.outputTokens ?? 0).toBeGreaterThan(0);
      // The model identifier should round-trip too
      // (CostTracker uses it for pricing).
      expect(typeof result.model).toBe("string");
    },
    30_000,
  );
});
