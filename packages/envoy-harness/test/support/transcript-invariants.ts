/**
 * Transcript invariants — the safety net for the durability work.
 *
 * Ported from codex's fixture-level `validate_request_body_invariants`,
 * which enforces provider wire invariants in ONE place so every test
 * benefits instead of each test re-asserting them. The class of bug it
 * catches is the one that poisons a resume: a `tool_call` with no
 * matching `tool_result`, a `tool_result` for a call that was never
 * issued, or two results for one call. Providers reject all three
 * (OpenAI answers `400`), and a replay could re-run a side effect.
 *
 * This module is deliberately dependency-free and usable from any test.
 */

import { describe, expect, it } from "vitest";

import type { ContentBlock, Message } from "../../src/index.js";
import { repairDanglingToolCalls } from "../../src/index.js";

/** A structural violation of the tool-call protocol. */
export interface TranscriptViolation {
  readonly kind:
    | "call_without_result"
    | "result_without_call"
    | "duplicate_result"
    | "duplicate_call_id"
    | "result_before_call"
    | "unterminated_tool_message";
  readonly detail: string;
}

/**
 * Check the tool-call/result symmetry of a transcript.
 *
 * Returns every violation rather than throwing, so a caller can report
 * all of them at once.
 */
export function findTranscriptViolations(
  messages: ReadonlyArray<Message>,
): TranscriptViolation[] {
  const violations: TranscriptViolation[] = [];
  const issuedAt = new Map<string, number>();

  // Pass 1: index every tool call (so a result can be diagnosed as
  // "unknown" versus "out of order", which a single forward pass cannot
  // distinguish), and catch malformed tool messages.
  messages.forEach((message, index) => {
    for (const block of message.content) {
      if (block.type !== "tool_call") continue;
      if (issuedAt.has(block.id)) {
        violations.push({
          kind: "duplicate_call_id",
          detail: `tool_call id "${block.id}" issued twice (index ${index})`,
        });
      }
      issuedAt.set(block.id, index);
    }
    if (message.role === "tool" && message.content.length === 0) {
      violations.push({
        kind: "unterminated_tool_message",
        detail: `empty tool message at index ${index}`,
      });
    }
  });

  // Pass 2: check every result against the call index.
  const resultAt = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const id = block.toolCallId;
      if (typeof id !== "string" || id.length === 0) {
        violations.push({
          kind: "result_without_call",
          detail: `tool_result with no toolCallId at index ${index}`,
        });
        continue;
      }
      const callIndex = issuedAt.get(id);
      if (callIndex === undefined) {
        violations.push({
          kind: "result_without_call",
          detail: `tool_result for unknown call "${id}" (index ${index})`,
        });
      } else if (callIndex > index) {
        violations.push({
          kind: "result_before_call",
          detail: `tool_result for "${id}" precedes its call (index ${index})`,
        });
      }
      if (resultAt.has(id)) {
        violations.push({
          kind: "duplicate_result",
          detail: `second tool_result for "${id}" (index ${index})`,
        });
      }
      resultAt.set(id, index);
    }
  });

  for (const [id, index] of issuedAt) {
    if (!resultAt.has(id)) {
      violations.push({
        kind: "call_without_result",
        detail: `tool_call "${id}" at index ${index} has no result`,
      });
    }
  }
  return violations;
}

/** Convenience assert for tests. */
export function expectValidTranscript(
  messages: ReadonlyArray<Message>,
): void {
  const violations = findTranscriptViolations(messages);
  expect(violations.map((v) => `${v.kind}: ${v.detail}`)).toEqual([]);
}

// ---------------------------------------------------------------------------

function call(id: string): ContentBlock {
  return { type: "tool_call", id, name: "bash", args: { command: "true" } };
}
function result(id: string): ContentBlock {
  return { type: "tool_result", toolCallId: id, content: "ok", isError: false };
}
const assistant = (...content: ContentBlock[]): Message => ({ role: "assistant", content });
const tool = (...content: ContentBlock[]): Message => ({ role: "tool", content });

describe("findTranscriptViolations", () => {
  it("accepts a symmetric transcript", () => {
    expectValidTranscript([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      assistant(call("c1"), call("c2")),
      tool(result("c1"), result("c2")),
      assistant({ type: "text", text: "done" }),
    ]);
  });

  it("accepts a transcript with no tool use", () => {
    expectValidTranscript([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      assistant({ type: "text", text: "hello" }),
    ]);
  });

  it("flags a call with no result (the crash-window bug)", () => {
    const violations = findTranscriptViolations([assistant(call("c1"))]);
    expect(violations.map((v) => v.kind)).toContain("call_without_result");
  });

  it("flags a result for a call that was never issued", () => {
    const violations = findTranscriptViolations([assistant(), tool(result("ghost"))]);
    expect(violations.map((v) => v.kind)).toContain("result_without_call");
  });

  it("flags a duplicate result for one call", () => {
    const violations = findTranscriptViolations([
      assistant(call("c1")),
      tool(result("c1")),
      tool(result("c1")),
    ]);
    expect(violations.map((v) => v.kind)).toContain("duplicate_result");
  });

  it("flags a duplicate tool_call id", () => {
    const violations = findTranscriptViolations([assistant(call("c1"), call("c1"))]);
    expect(violations.map((v) => v.kind)).toContain("duplicate_call_id");
  });

  it("flags a result that precedes its call", () => {
    const violations = findTranscriptViolations([tool(result("c1")), assistant(call("c1"))]);
    expect(violations.map((v) => v.kind)).toContain("result_before_call");
  });

  it("flags a result with no toolCallId", () => {
    const violations = findTranscriptViolations([
      assistant(call("c1")),
      tool({ type: "tool_result", content: "x" } as never),
    ]);
    expect(violations.map((v) => v.kind)).toContain("result_without_call");
  });
});

describe("repair and the invariant agree", () => {
  it("repairing a dangling call makes the transcript valid", () => {
    const broken: Message[] = [
      assistant(call("c1"), call("c2")),
      tool(result("c1")),
    ];
    expect(findTranscriptViolations(broken).map((v) => v.kind)).toContain(
      "call_without_result",
    );

    const { messages } = repairDanglingToolCalls(broken);
    expectValidTranscript(messages);
  });

  it("a repaired transcript keeps the original messages in order", () => {
    const broken: Message[] = [assistant(call("c1"))];
    const { messages } = repairDanglingToolCalls(broken);
    expect(messages[0]).toEqual(broken[0]);
    expect(messages).toHaveLength(2);
  });
});
