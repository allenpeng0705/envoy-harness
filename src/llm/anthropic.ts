/**
 * AnthropicAdapter — `ModelAdapter` for Anthropic's Messages API.
 *
 * **Design:** translates the harness's `ModelAdapter.complete()`
 * to Anthropic's POST `/v1/messages` wire format. The HTTP layer
 * goes through `HttpClient` (so tests use `FakeHttpClient`).
 *
 * **Wire format differences from OpenAI** (see implementation-plan
 * §6.2, F7.3 plan for the full table):
 * - Auth: `x-api-key` + `anthropic-version: 2023-06-01` headers
 *   (not `Authorization: Bearer`).
 * - System prompt is a top-level `system` field, NOT a message
 *   with `role: "system"`. `splitSystemAndMessages` extracts.
 * - Tool shape is flat `{ name, description, input_schema }`
 *   (no `function` wrapper, `input_schema` instead of
 *   `parameters`).
 * - Tool call in response is `content: [{ type: "tool_use",
 *   id, name, input }]` — mixed with text in one array.
 * - Tool results in the request are `role: "user"` with
 *   `content: [{ type: "tool_result", tool_use_id, content }]`.
 * - `max_tokens` is **required** by Anthropic. We default to
 *   `1024` (Anthropic's recommended default) when the caller
 *   doesn't pass one.
 * - `usage` field names are `input_tokens` / `output_tokens`
 *   (already matches our `ModelResponse.usage`).
 *
 * **Role alternation:** Anthropic's API requires strict
 * user ↔ assistant alternation. The harness's normal flow
 * (`user / assistant / tool / assistant / ...`) translates
 * directly: `user` stays `user`, `tool` becomes `user` with
 * `tool_result` blocks, `assistant` stays `assistant`.
 * v0 trusts the caller; we don't merge consecutive same-role
 * messages (a future chunk can add that if a real caller
 * produces them).
 *
 * **Empty assistant content:** Anthropic rejects empty
 * assistant content. If the harness emits an assistant
 * message with no text and no tool calls, we emit a single
 * placeholder text block `""` to keep the request valid.
 *
 * **Streaming:** v0 uses non-streaming `complete()`. The
 * Anthropic API supports `stream: true`; a future chunk
 * can add a streaming variant of `ModelAdapter`.
 *
 * **Stability:** the public surface is `AnthropicAdapter`
 * (class), `AnthropicAdapterOptions`, and the exported
 * helper functions (used by tests). Additive; new options
 * don't break existing callers.
 */

import {
  FetchHttpClient,
  zodToJsonSchema,
  type HttpClient,
  type HttpResponse,
} from "./http.js";
import type { ContentBlock, Message, Tool } from "../tools/types.js";
import type {
  CompleteInput,
  ModelAdapter,
  ModelResponse,
} from "../model.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for `AnthropicAdapter`. */
export interface AnthropicAdapterOptions {
  /** The API key. Required. */
  apiKey: string;
  /** The model identifier (e.g. "claude-sonnet-4-6", "claude-haiku-4"). */
  model: string;
  /** Custom base URL. Default: `https://api.anthropic.com`. */
  baseUrl?: string;
  /** The HTTP client. Default: `new FetchHttpClient()`. */
  httpClient?: HttpClient;
  /** Anthropic API version. Default: `2023-06-01`. */
  anthropicVersion?: string;
  /** Default `max_tokens` when the caller doesn't pass one. Default: `1024`. */
  defaultMaxTokens?: number;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Wire types (Anthropic-specific)
// ---------------------------------------------------------------------------

/** A text block in an assistant content array. */
interface AnthropicTextBlock {
  type: "text";
  text: string;
}

/** A tool-use block in an assistant content array. */
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool-result block in a user content array. */
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

/** A message in Anthropic's wire format. */
type AnthropicWireMessage =
  | { role: "user"; content: string }
  | { role: "user"; content: AnthropicToolResultBlock[] }
  | { role: "assistant"; content: Array<AnthropicTextBlock | AnthropicToolUseBlock> };

/** A tool definition in Anthropic's wire format. */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A response from Anthropic's `/v1/messages` (the parts we read). */
interface AnthropicMessagesResponse {
  id?: string;
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/** An error response from Anthropic. */
interface AnthropicErrorResponse {
  error?: {
    message: string;
    type?: string;
  };
}

// ---------------------------------------------------------------------------
// AnthropicAdapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements ModelAdapter {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private http: HttpClient;
  private version: string;
  private defaultMaxTokens: number;

  constructor(options: AnthropicAdapterOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.http = options.httpClient ?? new FetchHttpClient();
    this.version = options.anthropicVersion ?? DEFAULT_VERSION;
    this.defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(input: CompleteInput): Promise<ModelResponse> {
    const { system, messages } = splitSystemAndMessages(input.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: input.maxTokens ?? this.defaultMaxTokens,
    };
    if (system.length > 0) {
      body.system = system;
    }
    body.messages = messagesToAnthropic(messages);
    if (input.tools.length > 0) {
      body.tools = toolsToAnthropic(input.tools);
    }
    if (input.temperature !== undefined) {
      body.temperature = input.temperature;
    }
    const response = await this.http.request({
      method: "POST",
      url: `${this.baseUrl}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.version,
      },
      body: JSON.stringify(body),
    });
    if (!is2xx(response.status)) {
      throw new Error(parseError(response));
    }
    const parsed = JSON.parse(response.body) as AnthropicMessagesResponse;
    return parseMessagesResponse(parsed);
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/** True for 2xx HTTP status codes. */
export function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Convert an Anthropic error response into a one-line message. */
export function parseError(response: HttpResponse): string {
  try {
    const parsed = JSON.parse(response.body) as AnthropicErrorResponse;
    if (parsed.error?.message) {
      return `Anthropic API error (${response.status}): ${parsed.error.message}`;
    }
  } catch {
    // fall through
  }
  return `Anthropic API error (${response.status}): ${response.body.slice(0, 200)}`;
}

/**
 * Pull the system prompt out of the message list. Anthropic's
 * wire format has a top-level `system` field; the harness's
 * `Message[]` has a `role: "system"` message. We extract all
 * system text blocks and concatenate with a blank line between
 * them. Returns the system string (empty if no system messages)
 * and the remaining non-system messages.
 */
export function splitSystemAndMessages(messages: ReadonlyArray<Message>): {
  system: string;
  messages: ReadonlyArray<Message>;
} {
  const sysBlocks: string[] = [];
  const rest: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      for (const b of m.content) {
        if (b.type === "text" && typeof b.text === "string") {
          sysBlocks.push(b.text);
        }
      }
    } else {
      rest.push(m);
    }
  }
  return { system: sysBlocks.join("\n\n"), messages: rest };
}

/** Convert our `Tool[]` to Anthropic's wire format. */
export function toolsToAnthropic(tools: ReadonlyArray<Tool>): AnthropicToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: zodToJsonSchema(t.parameters),
  }));
}

/**
 * Convert our internal `Message[]` to Anthropic's wire format.
 * Tool results become `role: "user"` with `content: [{ type:
 * "tool_result", tool_use_id, content }]`. Assistant text and
 * tool calls are merged into one `content` array.
 *
 * **Empty assistant content** is replaced with a single
 * placeholder text block (Anthropic rejects empty content).
 */
export function messagesToAnthropic(
  messages: ReadonlyArray<Message>,
): AnthropicWireMessage[] {
  const out: AnthropicWireMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [];
      for (const b of m.content) {
        if (b.type === "text") {
          content.push({ type: "text", text: b.text });
        } else if (b.type === "tool_call") {
          content.push({
            type: "tool_use",
            id: b.id,
            name: b.name,
            input: isRecord(b.args) ? b.args : {},
          });
        }
      }
      // Anthropic rejects empty content; emit a placeholder.
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    if (m.role === "user") {
      // A user message can be plain text OR tool results.
      // Emit one wire message per kind (one for text, one for
      // tool_results). Empty user messages are skipped.
      const text = blocksToText(m.content.filter((b) => b.type === "text"));
      if (text.length > 0) {
        out.push({ role: "user", content: text });
      }
      const toolResults = collectToolResults(m.content);
      if (toolResults.length > 0) {
        out.push({ role: "user", content: toolResults });
      }
      continue;
    }
    if (m.role === "tool") {
      const toolResults = collectToolResults(m.content);
      if (toolResults.length > 0) {
        out.push({ role: "user", content: toolResults });
      }
    }
  }
  return out;
}

/** Extract tool_result blocks from a message's content array. */
function collectToolResults(
  blocks: ReadonlyArray<ContentBlock>,
): AnthropicToolResultBlock[] {
  const out: AnthropicToolResultBlock[] = [];
  for (const b of blocks) {
    if (b.type === "tool_result") {
      out.push({
        type: "tool_result",
        tool_use_id: b.toolCallId,
        content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
      });
    }
  }
  return out;
}

/** Concatenate text blocks into a single string. */
function blocksToText(
  blocks: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return blocks
    .filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

/** True if `x` is a non-null object (used for tool-call args). */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Convert Anthropic's response into our `ModelResponse`. */
export function parseMessagesResponse(
  parsed: AnthropicMessagesResponse,
): ModelResponse {
  const content: ContentBlock[] = [];
  for (const block of parsed.content ?? []) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      content.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        args: block.input ?? {},
      });
    }
  }
  const stopReason = mapStopReason(parsed.stop_reason);
  return {
    content,
    stopReason,
    model: parsed.model,
    ...(parsed.usage
      ? {
          usage: {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
          },
        }
      : {}),
  };
}

function mapStopReason(
  reason: AnthropicMessagesResponse["stop_reason"],
): ModelResponse["stopReason"] {
  switch (reason) {
    case "end_turn":
    case null:
    case undefined:
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "tool_use":
      return "tool_use";
  }
}
