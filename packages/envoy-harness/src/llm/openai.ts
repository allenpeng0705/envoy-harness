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
 * **Streaming:** v0 uses non-streaming `complete()`. The
 * OpenAI API supports `stream: true`; a future chunk can
 * add a streaming variant of `ModelAdapter`.
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
  };
}

/** An error response from OpenAI (the parts we read). */
interface OpenAIErrorResponse {
  error?: {
    message: string;
    type?: string;
    code?: string | null;
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
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages: messagesToOpenAI(input.messages),
      ...(input.tools.length > 0 ? { tools: toolsToOpenAI(input.tools) } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
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
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        // Malformed JSON; leave args as {} (the tool's zod
        // validation will surface the error to the model).
      }
      content.push({
        type: "tool_call",
        id: tc.id,
        name: tc.function.name,
        args,
      });
    }
  }
  const stopReason = mapStopReason(choice.finish_reason);
  return {
    content,
    stopReason,
    model: parsed.model,
    ...(parsed.usage
      ? {
          usage: {
            inputTokens: parsed.usage.prompt_tokens,
            outputTokens: parsed.usage.completion_tokens,
          },
        }
      : {}),
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
