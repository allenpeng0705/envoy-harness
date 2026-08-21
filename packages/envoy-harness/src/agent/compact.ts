/**
 * Compaction helpers — the drop-oldest and LLM-summarize
 * variants behind `Agent.compact` / `Agent.compactWithSummary`
 * (wired to the REPL's `/compact` command and available to the
 * host for a manual "compact" button).
 *
 * **Why separate from `agent.ts`:** agent.ts exceeds the 800-line
 * module cap (documented allowlist exception). Compaction is
 * self-contained transcript math with no dependency on the
 * Agent's loop, tools, or hooks — it is the first extraction
 * candidate, so it gets its own module.
 *
 * **Behavior contract (shared by both variants):**
 * - The system message (if present) is always preserved at the
 *   start of the transcript.
 * - The last `keep` non-system messages are kept.
 * - If there is nothing to drop, the transcript is returned
 *   unchanged (no summarizer call, no mutation).
 *
 * **`compactMessagesWithSummary`:** drops the oldest messages and
 * inserts a summary of the dropped messages as a USER message
 * (not system — see the function docs for why), before the kept
 * messages. The summarizer is injected by the caller (host
 * policy owns cost/prompting); an empty summary adds no block.
 */

import type { Message } from "../tools/index.js";

/**
 * Drop the oldest messages, keeping the last `keep` non-system
 * messages plus the system message (if present). Returns the new
 * transcript. No-op when the transcript is not longer than
 * `keep` (ignoring the system message).
 */
export function compactMessages(
  messages: ReadonlyArray<Message>,
  keep: number,
): Message[] {
  const parts = splitSystemAndRest(messages);
  if (parts.rest.length <= keep) {
    // Nothing to compact.
    return messages.slice();
  }
  return rebuild(parts.system, parts.rest.slice(-keep));
}

/** The result of a summarized compaction. */
export interface CompactWithSummaryResult {
  /** The new transcript (same content as the input when no-op). */
  messages: Message[];
  /**
   * How many messages were dropped. `0` means "nothing to drop"
   * — the caller should treat the result as a no-op (the summary
   * insertion can keep the message COUNT unchanged while changing
   * content, so callers must not infer no-op from length).
   */
  droppedCount: number;
}

/**
 * Compact with LLM summarization (Codex compaction parity).
 * Drops the oldest messages (keeping the last `keep` + the
 * system message) and injects a summary of the dropped messages,
 * so the model keeps the gist without the full history.
 *
 * **No-op** when the transcript is shorter than `keep` (nothing
 * to summarize — the summarizer is not called). The summary is
 * inserted BEFORE the kept messages so the model sees it as
 * prior context.
 *
 * @param keep The number of most-recent messages to keep.
 * @param summarize Receives the dropped messages and returns
 *   a summary string (may be empty — then no block is added).
 */
export async function compactMessagesWithSummary(
  messages: ReadonlyArray<Message>,
  keep: number,
  summarize: (dropped: ReadonlyArray<Message>) => Promise<string>,
): Promise<CompactWithSummaryResult> {
  const parts = splitSystemAndRest(messages);
  if (parts.rest.length <= keep) {
    return { messages: messages.slice(), droppedCount: 0 };
  }
  const toKeep = parts.rest.slice(-keep);
  const dropped = parts.rest.slice(0, parts.rest.length - keep);
  const summary = await summarize(dropped);
  const out: Message[] = [];
  if (parts.system) out.push(parts.system);
  if (summary.trim().length > 0) {
    // Insert the summary as a USER message, NOT a system
    // message: `Agent.run()` treats the presence of ANY system
    // message as "the system prompt is already installed" and
    // would skip appending the real system prompt on the next
    // turn. A labeled user block carries the context without
    // conflicting with the system prompt.
    out.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `The following earlier context was summarized away:\n${summary.trim()}`,
        },
      ],
    });
  }
  for (const m of toKeep) out.push(m);
  return { messages: out, droppedCount: dropped.length };
}

/** Split the leading system message (if any) from the rest. */
function splitSystemAndRest(
  messages: ReadonlyArray<Message>,
): { system: Message | undefined; rest: Message[] } {
  // The system message is always at the start in v0 per
  // agent.run's logic; if present, preserve it.
  const hasSystem = messages.length > 0 && messages[0]?.role === "system";
  return {
    system: hasSystem ? messages[0] : undefined,
    rest: messages.slice(hasSystem ? 1 : 0),
  };
}

/** Rebuild a transcript as plain role + content pairs. */
function rebuild(
  system: Message | undefined,
  rest: Message[],
): Message[] {
  const out: Message[] = [];
  if (system) {
    out.push({ role: system.role, content: system.content });
  }
  for (const m of rest) {
    out.push({ role: m.role, content: m.content });
  }
  return out;
}
