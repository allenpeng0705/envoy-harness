/**
 * Model adapter — the pluggable surface for "the LLM".
 *
 * **Design doc:** `docs/design.md` §3.4 (runtime core, model call).
 *
 * **Why an interface?** envoy-harness is a harness, not a model
 * vendor. The user can wire it to OpenAI, Anthropic, DeepSeek,
 * Ollama, or a local stub. A `ModelAdapter` interface keeps the
 * runtime agnostic. (Per design target #2 — independently
 * runnable — the harness must work with a fake model for tests
 * and demos.)
 *
 * **`complete()` is the only required method.** Streaming is
 * optional and lives behind a separate method
 * (`completeStreaming`, added in a later chunk). The non-streaming
 * path is enough for v0: get the response, dispatch tool calls,
 * repeat. Streaming is a UX improvement, not a correctness one.
 *
 * **Wire compatibility:** `messages` and `tools` use the local
 * `Message` / `Tool` types from `../tools/types.js`. An adapter
 * for OpenAI / Anthropic translates to the vendor's wire format.
 * The local types are the canonical source of truth; vendor
 * types are derived.
 *
 * **Stability:** the interface is `complete()`. Adding a method
 * is additive; changing the signature is a major version bump.
 */

import type { Message, Tool } from "./tools/types.js";

/**
 * What a model returns from one `complete()` call. The agent
 * extracts text and tool calls from `content` and dispatches.
 *
 * **No `usage` field in v0.** Cost tracking is §14 of the design
 * and is a future chunk. Add `usage: { inputTokens, outputTokens }`
 * when that lands.
 */
export interface ModelResponse {
  content: Message["content"];
  /**
   * Why the model stopped. `end_turn` = no tool calls, agent loop
   * exits. `tool_use` = at least one tool call, loop continues.
   * `max_tokens` = truncated; the agent may want to retry.
   * `stop_sequence` = hit a stop sequence; treated like `end_turn`.
   */
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
}

/**
 * The input to `complete()`. Bundled in an object so we can
 * add fields (temperature, max_tokens, system prompt overrides)
 * without breaking the signature.
 */
export interface CompleteInput {
  /** The full transcript so far. The adapter may add a system prompt. */
  messages: ReadonlyArray<Message>;
  /** Tools the model can call. Empty array = no tool use allowed. */
  tools: ReadonlyArray<Tool>;
  /**
   * Optional model identifier (e.g. "claude-opus-4",
   * "deepseek-chat"). Adapters that support multiple models
   * use this; adapters that don't can ignore it.
   */
  model?: string;
  /**
   * Sampling temperature, in [0, 2]. Adapters that don't
   * support temperature can ignore it.
   */
  temperature?: number;
  /**
   * Maximum output tokens. Adapters that don't support a cap
   * can ignore it.
   */
  maxTokens?: number;
}

/**
 * The contract every model adapter satisfies. Implementations
 * may be HTTP-based (OpenAI, Anthropic), local (Ollama), or
 * scripted (FakeModel for tests).
 *
 * **Errors:** adapters should throw on network / auth / parse
 * failures. The agent's loop has a try/catch that records the
 * error in the transcript and either retries or surfaces it to
 * the user, depending on configuration. Per design §17
 * (Error handling), errors are first-class — they get a
 * dedicated `error` ContentBlock in the transcript.
 */
export interface ModelAdapter {
  complete(input: CompleteInput): Promise<ModelResponse>;
}
