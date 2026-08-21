/**
 * Tests for `src/context/budget.ts` — the token-budget
 * compaction math.
 *
 * Covers:
 * 1. `estimateMessageTokens`:
 *    - text block: ceil(chars/4) + structural overhead
 *    - tool call: name + JSON args + overhead
 *    - tool result: content + overhead
 *    - mixed blocks: sum
 *    - empty message: 0 tokens
 *    - determinism (same input → same output)
 * 2. `totalTokens`: sum of per-message estimates
 * 3. `selectDroppablePrefix`:
 *    - empty input → no-op
 *    - system message only (fits) → kept
 *    - system message only (over budget) → overBudget=true
 *    - no system, all fit → no drop
 *    - 5 messages, budget fits 3 → drops 2
 *    - budget = 0 → kept = system only
 *    - long system + many short messages → drops until fit
 *    - dropped messages in transcript order
 *
 * **Hermetic:** pure function tests, no I/O, no native deps.
 */

import { describe, expect, it } from "vitest";

import {
  estimateMessageTokens,
  selectDroppablePrefix,
  totalTokens,
} from "../../src/context/budget.js";
import type { Message } from "../../src/tools/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sys(text: string): Message {
  return { role: "system", content: [{ type: "text", text }] };
}
function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function toolCall(name: string, args: unknown, id = "t1"): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id, name, args }],
  };
}
function toolResult(content: string, id = "t1"): Message {
  return {
    role: "tool",
    content: [{ type: "tool_result", toolCallId: id, content, isError: false }],
  };
}

// ---------------------------------------------------------------------------
// estimateMessageTokens
// ---------------------------------------------------------------------------

describe("estimateMessageTokens", () => {
  it("estimates text-only messages at ceil(chars/4) + per-block overhead", () => {
    // 4 chars text + 16 chars overhead = 20 chars → ceil(20/4) = 5 tokens.
    const m: Message = { role: "user", content: [{ type: "text", text: "abcd" }] };
    expect(estimateMessageTokens(m)).toBe(5);
  });

  it("returns 0 for an empty message", () => {
    const m: Message = { role: "user", content: [] };
    expect(estimateMessageTokens(m)).toBe(0);
  });

  it("adds tool-call overhead for tool_call blocks", () => {
    const m = toolCall("bash", { command: "ls -la" });
    // name: "bash" = 4 chars; args JSON: '{"command":"ls -la"}' = 20 chars;
    // overhead: 32 chars. Total: 4 + 20 + 32 = 56 → ceil(56/4) = 14 tokens.
    expect(estimateMessageTokens(m)).toBe(14);
  });

  it("adds tool-result overhead for tool_result blocks", () => {
    const m = toolResult("file contents here");
    // content: 19 chars; overhead: 32. Total: 51 → ceil(51/4) = 13 tokens.
    expect(estimateMessageTokens(m)).toBe(13);
  });

  it("handles tool_result with non-string content", () => {
    const m: Message = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "t1",
          content: { ok: true, n: 42 },
          isError: false,
        },
      ],
    };
    // content JSON: '{"ok":true,"n":42}' = 18 chars; overhead 32. Total 50 → 13.
    expect(estimateMessageTokens(m)).toBe(13);
  });

  it("sums per-block estimates for mixed blocks", () => {
    const m: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "I'll run a command" },
        { type: "tool_call", id: "t1", name: "bash", args: { command: "ls" } },
      ],
    };
    // text: 18 + 16 = 34 chars → ceil(34/4) = 9 tokens.
    // tool_call: 4 (name) + 15 (args JSON `{"command":"ls"}`) + 32 (overhead) = 51 → 13.
    // Sum: 9 + 13 = 22 tokens.
    expect(estimateMessageTokens(m)).toBe(22);
  });

  it("is deterministic (same input → same output)", () => {
    const m = user("hello world");
    const a = estimateMessageTokens(m);
    const b = estimateMessageTokens(m);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// totalTokens
// ---------------------------------------------------------------------------

describe("totalTokens", () => {
  it("returns 0 for an empty transcript", () => {
    expect(totalTokens([])).toBe(0);
  });

  it("is the sum of per-message estimates", () => {
    const messages = [user("abcd"), user("abcdefgh")];
    // 4-char user → 5 tokens (with overhead); 8-char user → 6 tokens.
    // Sum = 11.
    expect(totalTokens(messages)).toBe(
      estimateMessageTokens(messages[0]!) + estimateMessageTokens(messages[1]!),
    );
  });
});

// ---------------------------------------------------------------------------
// selectDroppablePrefix
// ---------------------------------------------------------------------------

describe("selectDroppablePrefix", () => {
  it("returns no-op for an empty input", () => {
    const r = selectDroppablePrefix([], 100);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.totalTokensAfter).toBe(0);
    expect(r.overBudget).toBe(false);
  });

  it("keeps the system message when it fits", () => {
    const messages = [sys("S")];
    const r = selectDroppablePrefix(messages, 100);
    expect(r.kept).toEqual(messages);
    expect(r.dropped).toEqual([]);
    expect(r.overBudget).toBe(false);
  });

  it("returns overBudget when the system message alone exceeds the budget", () => {
    // System message: 50 chars text + 16 overhead = 66 → ceil(66/4) = 17 tokens.
    // Budget = 5 → overBudget.
    const messages = [sys("a".repeat(50))];
    const r = selectDroppablePrefix(messages, 5);
    expect(r.kept).toEqual(messages);
    expect(r.overBudget).toBe(true);
  });

  it("keeps the system + recent messages when they fit", () => {
    const messages = [sys("S"), user("a"), user("b"), user("c")];
    // Each user: 1 char + 16 overhead = 17 → ceil(17/4) = 5 tokens.
    // system: 1 char + 16 overhead = 17 → 5 tokens.
    // Total per message: 5. Budget = 12 → fits system + 1 message.
    const r = selectDroppablePrefix(messages, 12);
    expect(r.kept).toEqual([sys("S"), user("c")]);
    expect(r.dropped).toEqual([user("a"), user("b")]);
    expect(r.totalTokensAfter).toBe(10);
    expect(r.overBudget).toBe(false);
  });

  it("drops from the start, stopping when adding the next would exceed the budget", () => {
    const messages = [
      sys("S"),
      user("a".repeat(40)), // 40+16=56 → 14
      user("b".repeat(40)), // 14
      user("c".repeat(40)), // 14
      user("d".repeat(40)), // 14
    ];
    // Budget = 30 → fits system (5) + 1 user (14) + 1 user (14) = 33... too much.
    // Actually: system is 5. First user (last) is 14 → 5+14=19 fits. Next: 19+14=33 > 30. Stop.
    // So kept = [sys, last user (d)].
    // Wait — that's wrong. Let me re-read the algorithm.
    // We walk from end. The LAST user is "d". total = 5 (sys) + 14 (d) = 19. fits.
    // Then the PREVIOUS user is "c". 19 + 14 = 33 > 30. stop. kept = [sys, d].
    // dropped = [a, b, c]. Hmm, that's 3 dropped, not 2.
    // Actually the algorithm: suffixStart starts at rest.length (=4).
    // Iterate i=3 (d): running=19, suffixStart=3.
    // Iterate i=2 (c): 19+14=33 > 30. break.
    // suffixStart = 3 → kept = [sys, rest[3], rest[4]] = [sys, d] (only 1 rest fits).
    // dropped = rest[0..3] = [a, b, c].
    const r = selectDroppablePrefix(messages, 30);
    expect(r.kept).toEqual([sys("S"), user("d".repeat(40))]);
    expect(r.dropped).toEqual([
      user("a".repeat(40)),
      user("b".repeat(40)),
      user("c".repeat(40)),
    ]);
    expect(r.overBudget).toBe(false);
  });

  it("keeps just the system when budget = 0", () => {
    const messages = [sys("S"), user("a"), user("b")];
    const r = selectDroppablePrefix(messages, 0);
    // system: 5 tokens > 0 → overBudget = true.
    expect(r.kept).toEqual([sys("S")]);
    expect(r.dropped).toEqual([user("a"), user("b")]);
    expect(r.overBudget).toBe(true);
  });

  it("returns empty kept + overBudget when no system and no messages fit", () => {
    const messages = [user("a".repeat(100))]; // 116 chars → 29 tokens
    const r = selectDroppablePrefix(messages, 0);
    // No system, user is 29 tokens > 0. suffixStart stays at rest.length.
    // kept = []. dropped = [user]. overBudget = true.
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(messages);
    expect(r.overBudget).toBe(true);
  });

  it("preserves transcript order in the dropped array", () => {
    const messages = [sys("S"), user("a"), user("b"), user("c")];
    const r = selectDroppablePrefix(messages, 12);
    // We expect dropped = [user("a"), user("b")].
    expect(r.dropped).toEqual([user("a"), user("b")]);
  });

  it("handles a long prefix (old messages) and short suffix (recent)", () => {
    // system: 1 char + 16 overhead = 17 chars → 5 tokens.
    // old messages: 2-3 chars ("u0".."u49") + 16 overhead = 18-19 chars → 5 tokens each.
    // recent: 2 chars ("r1"/"r2"/"r3") + 16 overhead = 18 chars → 5 tokens each.
    //
    // Transcript order: [sys, u0, ..., u49, r1, r2, r3].
    // Budget = 30. Walk from end:
    //   r3: 5 (running 5+5 sys=10). fits.
    //   r2: 5 (15). fits.
    //   r1: 5 (20). fits.
    //   u49: 5 (25). fits.
    //   u48: 5 (30). fits exactly.
    //   u47: would push to 35 — over. break.
    // → suffixStart = u48. The kept slice runs from
    //   suffixStart to end in TRANSCRIPT order: [u48, u49, r1, r2, r3].
    // → kept = [system, u48, u49, r1, r2, r3] (6 messages, 30 tokens).
    // → dropped = [u0..u47] (48 messages).
    const old = Array.from({ length: 50 }, (_, i) => user(`u${i}`));
    const recent = [user("r1"), user("r2"), user("r3")];
    const messages: Message[] = [sys("S"), ...old, ...recent];
    const r = selectDroppablePrefix(messages, 30);
    expect(r.kept).toEqual([
      sys("S"),
      user("u48"),
      user("u49"),
      user("r1"),
      user("r2"),
      user("r3"),
    ]);
    expect(r.dropped).toEqual(old.slice(0, 48));
    expect(r.overBudget).toBe(false);
  });
});
