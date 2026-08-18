/**
 * Test fixture: a scripted `ModelAdapter` for agent loop tests.
 *
 * **Why scripted:** the agent loop is the SUT; the model is
 * the dependency. We want to drive the loop deterministically
 * — one response per call, with a known tool-call sequence —
 * without standing up a real LLM. This fixture is the
 * "mock model adapter" used by every agent.test.ts test.
 *
 * **Not exported from the public API.** This lives in
 * `test/fixtures/` and is imported only by tests. Real model
 * adapters (OpenAI, Anthropic, etc.) land in a future chunk.
 *
 * **Stop-reason policy:** if a script entry has no tool calls,
 * the stop reason is `end_turn` (the agent exits). If it has
 * tool calls, it's `tool_use`. Callers can override.
 */

import type {
  CompleteInput,
  ModelAdapter,
  ModelResponse,
} from "../../src/index.js";

/** A single scripted step. */
export interface ScriptedResponse {
  /** The model's content blocks. */
  content: ModelResponse["content"];
  /** Override the inferred stop reason. Default: end_turn if no tool calls, else tool_use. */
  stopReason?: ModelResponse["stopReason"];
}

/** A scripted error to throw at a specific call. */
export interface ScriptedError {
  /** Error to throw when this entry is reached. */
  error: Error;
}

export type ScriptEntry = ScriptedResponse | ScriptedError;

export class FakeModel implements ModelAdapter {
  private script: ScriptEntry[];
  private callIndex = 0;
  public readonly calls: CompleteInput[] = [];

  constructor(script: ScriptEntry[]) {
    this.script = script;
  }

  async complete(input: CompleteInput): Promise<ModelResponse> {
    // Snapshot the messages at call time. The session is mutated
    // synchronously after this returns; capturing the input by
    // reference would let later mutations leak into the recorded
    // input. Tests can then inspect `calls[i].messages` and see
    // exactly what the model saw at call time.
    this.calls.push({
      ...input,
      messages: input.messages.map((m) => ({
        role: m.role,
        content: [...m.content],
      })),
    });
    const entry = this.script[this.callIndex++];
    if (!entry) {
      throw new Error(
        `FakeModel: script exhausted (call #${this.callIndex}); the agent loop called complete() more times than scripted`,
      );
    }
    if ("error" in entry) {
      throw entry.error;
    }
    // Default stop reason: end_turn if no tool calls, else tool_use.
    const hasToolCall = entry.content.some((b) => b.type === "tool_call");
    const stopReason =
      entry.stopReason ?? (hasToolCall ? "tool_use" : "end_turn");
    return {
      content: entry.content,
      stopReason,
    };
  }
}

/** Helper: build a one-shot text response (no tool calls). */
export function textResponse(text: string): ScriptedResponse {
  return { content: [{ type: "text", text }] };
}

/** Helper: build a tool_call content block. */
export function toolCall(
  id: string,
  name: string,
  args: unknown,
): Extract<ModelResponse["content"][number], { type: "tool_call" }> {
  return { type: "tool_call", id, name, args };
}
