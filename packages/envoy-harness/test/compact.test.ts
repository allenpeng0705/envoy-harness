/**
 * Tests for `src/agent/compact.ts` — the transcript-compaction
 * helpers extracted from `Agent.compact` / `Agent.compactWithSummary`.
 *
 * Covers:
 * 1. Drop-oldest: no-op when nothing to drop (system-message edge).
 * 2. Drop-oldest: keeps system + last N; drops the rest.
 * 3. Drop-oldest: transcript without a system message.
 * 4. Summarize: inserts the summary as a USER message before the
 *    kept messages, preserving the system message.
 * 5. Summarize: skips the summarizer when nothing would be dropped.
 * 6. Summarize: empty summary adds no block but still drops.
 */

import { describe, expect, it } from "vitest";

import {
  compactMessages,
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
});
