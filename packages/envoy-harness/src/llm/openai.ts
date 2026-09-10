/**
 * OpenAIAdapter — `ModelAdapter` for OpenAI's chat completions API.
 *
 * **Design:** translates the harness's `ModelAdapter.complete()`
 * to OpenAI's POST `/v1/chat/completions`. The HTTP layer
 * goes through `HttpClient` (so tests use `FakeHttpClient`).
 *
 * **Wire format mapping:**
 * - `messages` (assistant, user, system, tool) → OpenAI's
 *   `messages` array (see `messagesToOpenAI` in `http.ts`).
 * - `tools` → OpenAI's `tools` array (see `toolsToOpenAI`).
 * - Response's `choices[0].message` → our `ModelResponse.content`.
 * - Response's `choices[0].finish_reason` → our `stopReason`.
 * - Response's `usage` → our `ModelResponse.usage` (F7.1).
 *
 * **Auth:** `Authorization: Bearer ${apiKey}`. The key
 * comes from `OPENAI_API_KEY` env var (F7.5 wires this
 * in the bin) or the constructor argument.
 *
 * **Custom base URL:** `baseUrl` lets you point at a
 * OpenAI-compatible endpoint (Azure, vLLM, llama.cpp, etc.).
 * The default is `https://api.openai.com/v1`.
 *
 * **Streaming:** `complete()` uses the non-streaming endpoint
 * unless the caller supplies `onTextDelta`, in which case it delegates
 * to `completeStreaming()` (`stream: true`, SSE). Anthropic streaming
 * is still a separate piece of work.
 *
 * **Stability:** the public surface is `OpenAIAdapter`
 * (class) and its constructor options. Additive; new
 * options don't break existing callers.
 */

import {
  FetchHttpClient,
  messagesToOpenAI,
  toolsToOpenAI,
  type HttpClient,
  type HttpResponse,
  type OpenAIToolCall,
} from "./http.js";
import type {
  CompleteInput,
  ModelAdapter,
  ModelResponse,
} from "../model.js";

/** Options for `OpenAIAdapter`. */
export interface OpenAIAdapterOptions {
  /** The API key. Required. */
  apiKey: string;
  /** The model identifier (e.g. "gpt-4o", "gpt-4o-mini"). */
  model: string;
  /** Custom base URL. Default: `https://api.openai.com/v1`. */
  baseUrl?: string;
  /** The HTTP client. Default: `new FetchHttpClient()`. */
  httpClient?: HttpClient;
  /** Optional organization ID (sent as `OpenAI-Organization`). */
  organization?: string;
  /** Optional HTTP timeout in ms. No timeout by default. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** A response from OpenAI's `/v1/chat/completions` (the parts we read). */
interface OpenAIChatResponse {
  id?: string;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | "function_call";
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** DeepSeek's cache-hit counter. */
    prompt_cache_hit_tokens?: number;
    /** OpenAI's nested cache counter. */
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

/** An error response from OpenAI (the parts we read). */
interface OpenAIErrorResponse {
  error?: {
    message: string;
    type?: string;
    code?: string | null;
  };
}

/**
 * Some OpenAI-compatible providers (MiniMax, local llama-server, …) send
 * tool calls in the FLAT shape — `{ id, name, arguments }` — instead of
 * OpenAI's wrapper `{ id, function: { name, arguments } }`. Read both.
 */
type RawToolCall = {
  id?: string;
  function?: { name?: string; arguments?: string };
  name?: string;
  arguments?: string;
};

function readToolCallNameAndArgs(
  tc: RawToolCall,
): { name: string | undefined; arguments: string | undefined } {
  const fn = tc.function;
  return {
    name: fn?.name ?? tc.name,
    arguments: fn?.arguments ?? tc.arguments,
  };
}

export class OpenAIAdapter implements ModelAdapter {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private httpClient: HttpClient;
  private organization: string | undefined;

  constructor(options: OpenAIAdapterOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    // `http.ts` is already loaded at the top of this file for the
    // message/tool converters, so `new FetchHttpClient()` is a plain
    // constructor call — no extra module cost.
    this.httpClient =
      options.httpClient ??
      new FetchHttpClient(
        options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
      );
    this.organization = options.organization;
  }

  async complete(input: CompleteInput): Promise<ModelResponse> {
    if (input.onTextDelta !== undefined) {
      return this.completeStreaming(input);
    }
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages: messagesToOpenAI(input.messages),
      ...(input.tools.length > 0 ? { tools: toolsToOpenAI(input.tools) } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      // Pin the conversation to one server-side prefix-cache partition.
      ...(input.promptCacheKey !== undefined
        ? { prompt_cache_key: input.promptCacheKey }
        : {}),
    };
    const response = await this.httpClient.request({
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.organization ? { "OpenAI-Organization": this.organization } : {}),
      },
      body: JSON.stringify(body),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!is2xx(response.status)) {
      throw new Error(parseError(response));
    }
    const parsed = JSON.parse(response.body) as OpenAIChatResponse;
    return parseChatResponse(parsed);
  }

  /** Stream assistant text (and tool calls) via SSE when `onTextDelta` is set. */
  private async completeStreaming(input: CompleteInput): Promise<ModelResponse> {
    const onDelta = input.onTextDelta;
    if (onDelta === undefined) {
      throw new Error("completeStreaming requires onTextDelta");
    }
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      stream: true,
      messages: messagesToOpenAI(input.messages),
      ...(input.tools.length > 0 ? { tools: toolsToOpenAI(input.tools) } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.organization ? { "OpenAI-Organization": this.organization } : {}),
      },
      body: JSON.stringify(body),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(
        parseError({
          status: response.status,
          headers: {},
          body: errBody,
        }),
      );
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("OpenAI streaming: empty response body");
    }
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let fullText = "";
    let finishReason: ModelResponse["stopReason"] = "end_turn";
    let responseModel = this.model;
    let usage: ModelResponse["usage"] | undefined;
    let streamAborted = false;
    const toolParts = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    const processSseLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed === "data: [DONE]") return;
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice("data:".length).trim();
      if (payload.length === 0) return;
      const parsed = JSON.parse(payload) as {
        model?: string;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
        };
        choices?: Array<{
          finish_reason?:
            | "stop"
            | "tool_calls"
            | "length"
            | "content_filter"
            | "function_call"
            | null;
          delta?: {
            content?: string | null;
        tool_calls?: Array<{
          index: number;
          id?: string;
          function?: { name?: string; arguments?: string };
          name?: string;
          arguments?: string;
        }>;
          };
        }>;
      };
      if (parsed.model !== undefined) responseModel = parsed.model;
      if (parsed.usage != null) {
        usage = openAiUsage(parsed.usage);
      }
      const choice = parsed.choices?.[0];
      if (choice === undefined) return;
      if (
        choice.finish_reason !== undefined &&
        choice.finish_reason !== null
      ) {
        finishReason = mapStopReason(choice.finish_reason);
      }
      const delta = choice.delta;
      if (delta === undefined) return;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        fullText += delta.content;
        onDelta(delta.content);
      }
      if (delta.tool_calls !== undefined) {
        for (const tc of delta.tool_calls) {
          let acc = toolParts.get(tc.index);
          if (acc === undefined) {
            acc = { id: tc.id ?? "", name: "", args: "" };
            toolParts.set(tc.index, acc);
          }
          if (tc.id !== undefined) acc.id = tc.id;
          const { name, arguments: argsDelta } = readToolCallNameAndArgs(tc);
          if (name !== undefined && name.length > 0) acc.name = name;
          if (argsDelta !== undefined) acc.args += argsDelta;
        }
      }
    };

    while (true) {
      if (input.signal?.aborted) {
        streamAborted = true;
        try {
          await reader.cancel();
        } catch {
          // ignore cancel errors
        }
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processSseLine(line);
      }
    }
    if (sseBuffer.trim().length > 0) {
      processSseLine(sseBuffer);
    }

    const content: ModelResponse["content"] = [];
    if (fullText.length > 0) {
      content.push({ type: "text", text: fullText });
    }
    for (const part of [...toolParts.entries()].sort(([a], [b]) => a - b)) {
      const [, tc] = part;
      let args: unknown = {};
      try {
        args = JSON.parse(tc.args);
      } catch {
        // zod validation surfaces malformed args to the model.
      }
      content.push({
        type: "tool_call",
        id: tc.id,
        name: tc.name,
        args,
      });
    }
    if (
      !streamAborted &&
      content.some((b) => b.type === "tool_call")
    ) {
      finishReason = "tool_use";
    }
    return {
      content,
      stopReason: finishReason,
      model: responseModel,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/** True for 2xx HTTP status codes. */
export function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Convert an OpenAI error response into a one-line message. */
export function parseError(response: HttpResponse): string {
  try {
    const parsed = JSON.parse(response.body) as OpenAIErrorResponse;
    if (parsed.error?.message) {
      return `OpenAI API error (${response.status}): ${parsed.error.message}`;
    }
  } catch {
    // fall through
  }
  return `OpenAI API error (${response.status}): ${response.body.slice(0, 200)}`;
}

/** Convert OpenAI's response into our `ModelResponse`. */
export function parseChatResponse(parsed: OpenAIChatResponse): ModelResponse {
  const choice = parsed.choices[0];
  if (!choice) {
    return {
      content: [],
      stopReason: "end_turn",
      model: parsed.model,
    };
  }
  const content: ModelResponse["content"] = [];
  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      const { name, arguments: rawArgs } = readToolCallNameAndArgs(tc);
      let args: unknown = {};
      try {
        args = JSON.parse(rawArgs ?? "{}");
      } catch {
        // Malformed JSON; leave args as {} (the tool's zod
        // validation will surface the error to the model).
      }
      content.push({
        type: "tool_call",
        id: tc.id,
        name: name ?? "",
        args,
      });
    }
  }
  const stopReason = mapStopReason(choice.finish_reason);
  return {
    content,
    stopReason,
    model: parsed.model,
    ...(parsed.usage ? { usage: openAiUsage(parsed.usage) } : {}),
  };
}

/**
 * Map an OpenAI usage block to the harness's **disjoint** convention.
 *
 * OpenAI's `prompt_tokens` *includes* cached tokens; the harness's
 * `inputTokens` must exclude them so billed input is
 * `inputTokens + cacheReadTokens + cacheWriteTokens`. Without the
 * subtraction a cached conversation looks exactly as expensive as an
 * uncached one and the hit rate cannot be computed.
 *
 * `prompt_cache_hit_tokens` (DeepSeek) and
 * `prompt_tokens_details.cached_tokens` (OpenAI) are both accepted.
 */
export function openAiUsage(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
} {
  const cacheRead =
    usage.prompt_cache_hit_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    0;
  const uncached = Math.max(0, usage.prompt_tokens - cacheRead);
  return {
    inputTokens: uncached,
    outputTokens: usage.completion_tokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
  };
}

function mapStopReason(
  reason: "stop" | "tool_calls" | "length" | "content_filter" | "function_call",
): ModelResponse["stopReason"] {
  switch (reason) {
    case "stop":
    case "function_call":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "stop_sequence";
  }
}
