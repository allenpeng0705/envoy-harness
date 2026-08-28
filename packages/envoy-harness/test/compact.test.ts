/**
 * Tests for `src/agent/compact.ts` — the transcript-compaction
 * helpers extracted from `Agent.compact` / `Agent.compactWithSummary` /
 * `Agent.compactWithBudget`.
 *
 * Covers:
 * 1. Drop-oldest: no-op when nothing to drop (system-message edge).
 * 2. Drop-oldest: keeps system + last N; drops the rest.
 * 3. Drop-oldest: transcript without a system message.
 * 4. Summarize: inserts the summary as a USER message before the
 *    kept messages, preserving the system message.
 * 5. Summarize: skips the summarizer when nothing would be dropped.
 * 6. Summarize: empty summary adds no block but still drops.
 * 7. Summarize: summarizer-throws → drop-oldest fallback.
 * 8. Budget: no-op when the transcript fits.
 * 9. Budget: drops the prefix until the total fits.
 * 10. Budget: overBudget when the system message alone exceeds the budget.
 * 11. Budget: the math lives in `selectDroppablePrefix`; the
 *     function is a thin wrapper (verified by shape).
 */

import { describe, expect, it } from "vitest";

import {
  compactMessages,
  compactMessagesBudget,
  compactMessagesWithSummary,
} from "../src/agent/compact.js";
import type { Message } from "../src/tools/types.js";

function sys(text: string): Message {
  return { role: "system", content: [{ type: "text", text }] };
}
function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("compactMessages (drop-oldest)", () => {
  it("returns the transcript unchanged when nothing would be dropped", () => {
    const transcript = [sys("S"), user("u1"), assistant("a1")];
    // keep=2: exactly 2 non-system messages — nothing to drop.
    expect(compactMessages(transcript, 2)).toEqual(transcript);
  });

  it("keeps the system message and the last N non-system messages", () => {
    const transcript = [
      sys("S"),
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
    ];
    expect(compactMessages(transcript, 2)).toEqual([
      sys("S"),
      user("u2"),
      assistant("a2"),
    ]);
  });

  it("works without a system message", () => {
    const transcript = [user("u1"), assistant("a1"), user("u2")];
    expect(compactMessages(transcript, 1)).toEqual([user("u2")]);
  });
});

describe("compactMessagesWithSummary (LLM summarize)", () => {
  it("inserts the summary as a USER message before the kept messages", async () => {
    const transcript = [
      sys("S"),
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
    ];
    let dropped: Message[] = [];
    const { messages: out, droppedCount } = await compactMessagesWithSummary(
      transcript,
      2,
      async (d) => {
        dropped = [...d];
        return "SUMMARY";
      },
    );
    expect(dropped).toEqual([user("u1"), assistant("a1")]);
    expect(droppedCount).toBe(2);
    expect(out).toEqual([
      sys("S"),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The following earlier context was summarized away:\nSUMMARY",
          },
        ],
      },
      user("u2"),
      assistant("a2"),
    ]);
  });

  it("does not call the summarizer when nothing would be dropped", async () => {
    const transcript = [sys("S"), user("u1"), assistant("a1")];
    let called = false;
    const { messages: out, droppedCount } = await compactMessagesWithSummary(
      transcript,
      2,
      async () => {
        called = true;
        return "S";
      },
    );
    expect(called).toBe(false);
    expect(droppedCount).toBe(0);
    expect(out).toEqual(transcript);
  });

  it("drops the oldest messages even when the summary is empty", async () => {
    const transcript = [
      sys("S"),
      user("u1"),
      assistant("a1"),
      user("u2"),
    ];
    const { messages: out, droppedCount } = await compactMessagesWithSummary(
      transcript,
      1,
      async () => "",
    );
    expect(droppedCount).toBe(2);
    expect(out).toEqual([sys("S"), user("u2")]);
  });

  it("falls through to drop-oldest when the summarizer throws", async () => {
    const transcript = [
      sys("S"),
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
    ];
    const { messages: out, droppedCount } = await compactMessagesWithSummary(
      transcript,
      2,
      async () => {
        throw new Error("LLM unavailable");
      },
    );
    // No summary block (the fallback didn't call the
    // summarizer). The kept messages are the same as
    // `compactMessages(transcript, 2)`.
    expect(droppedCount).toBe(2);
    expect(out).toEqual([sys("S"), user("u2"), assistant("a2")]);
  });
});

// ---------------------------------------------------------------------------
// compactMessagesBudget (token-budget strategy — chunk 1.1)
// ---------------------------------------------------------------------------

describe("compactMessagesBudget (token budget)", () => {
  it("returns a no-op when the transcript fits the budget", () => {
    const transcript = [sys("S"), user("hi")];
    // system + 1 short user → well under any reasonable budget.
    const out = compactMessagesBudget(transcript, 10_000);
    expect(out.messages).toEqual(transcript);
    expect(out.droppedCount).toBe(0);
    expect(out.overBudget).toBe(false);
  });

  it("drops messages from the start until the total fits the budget", () => {
    // Each user: 2 chars + 16 overhead = 18 chars → 5 tokens.
    // system: 1 char + 16 overhead = 17 chars → 5 tokens.
    // Total: 6*5 = 30 tokens.
    const transcript = [
      sys("S"),
      user("a"),
      user("b"),
      user("c"),
      user("d"),
      user("e"),
    ];
    // Budget = 15: fits system (5) + 2 recent (10) = 15. Drops 3.
    const out = compactMessagesBudget(transcript, 15);
    expect(out.messages).toEqual([sys("S"), user("d"), user("e")]);
    expect(out.droppedCount).toBe(3);
    expect(out.totalTokensAfter).toBe(15);
    expect(out.overBudget).toBe(false);
  });

  it("returns overBudget when the system message alone exceeds the budget", () => {
    // system with a 50-char text → 17 tokens.
    // Budget = 5 → overBudget.
    const transcript = [sys("a".repeat(50))];
    const out = compactMessagesBudget(transcript, 5);
    expect(out.messages).toEqual(transcript);
    expect(out.droppedCount).toBe(0);
    expect(out.overBudget).toBe(true);
  });

  it("returns the overBudget flag when no non-system message fits", () => {
    const transcript = [user("a".repeat(100))]; // 29 tokens
    const out = compactMessagesBudget(transcript, 0);
    expect(out.messages).toEqual([]);
    expect(out.droppedCount).toBe(1);
    expect(out.overBudget).toBe(true);
  });
});
