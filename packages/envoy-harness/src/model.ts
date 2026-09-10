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
 * **`complete()` is the only required method.** Adapters that support
 * streaming implement it internally and enter it when the caller
 * supplies `onTextDelta` (see `llm/openai.ts#completeStreaming`); the
 * interface stays a single method so a fake or local adapter needs no
 * streaming code. Streaming is a UX improvement, not a correctness
 * one.
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
 * **`usage` (F7.1):** when the model reports token counts
 * (OpenAI, Anthropic, DeepSeek all do), the adapter puts
 * them here. The Agent loop feeds them into the CostTracker.
 * `FakeModel` (and other test adapters) may omit `usage` —
 * the cost is then 0 but the loop continues.
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
  /**
   * Token usage for this call. Optional — when omitted, the
   * cost is 0 for this call (no pricing data). The Agent
   * loop accumulates these into `AgentResult.metrics`.
   */
  usage?: {
    /**
     * **Uncached** input tokens only.
     *
     * Counts are DISJOINT: `inputTokens` must exclude anything
     * reported in `cacheReadTokens`/`cacheWriteTokens`, so billed input
     * is the sum of the three. Providers that fold cache hits into a
     * total prompt count (OpenAI's `prompt_tokens`, DeepSeek's
     * `prompt_tokens`) must subtract them out in the adapter — see
     * `llm/openai.ts`. Without this, cached input is invisible and the
     * hit rate cannot be computed at all.
     */
    inputTokens: number;
    outputTokens: number;
    /** Input tokens served from the provider's prefix cache. */
    cacheReadTokens?: number;
    /** Input tokens written into the provider's prefix cache. */
    cacheWriteTokens?: number;
  };
  /**
   * The model identifier that produced this response. The
   * Agent uses this to attribute cost (each model has its
   * own price). Optional — when omitted, the CostTracker
   * uses the model it was constructed with.
   */
  model?: string;
}

/**
 * The input to `complete()`. Bundled in an object so we can
 * add fields (temperature, max_tokens, system prompt overrides)
 * without breaking the signature — and so the prompt-cache key and
 * streaming callback can arrive without a signature change.
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
  /**
   * Optional abort signal. When provided, adapters forward it
   * to the HTTP layer so an aborted agent cancels in-flight
   * model calls instead of hanging until they return.
   */
  signal?: AbortSignal;
  /**
   * Optional streaming callback. When set, adapters that support
   * streaming emit assistant text deltas as they arrive. The agent
   * loop wires this from protocol hosts (`session/token`).
   */
  onTextDelta?: (delta: string) => void;
  /**
   * Stable partition key for the provider's prefix cache.
   *
   * Set to the **session id**, so every request in a conversation (and
   * every sub-agent it spawns) maps to the same server-side cache
   * partition. Codex does exactly this (`ModelClient::prompt_cache_key`
   * returns the session id, and an internal sub-session returns
   * `<source>:<parent_thread_id>` so children start on the parent's
   * warm prefix).
   *
   * Sent as `prompt_cache_key` on OpenAI-compatible endpoints, which is
   * accepted by `chat/completions` — no transport change needed.
   * Adapters that do not understand it ignore it.
   */
  promptCacheKey?: string;
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
