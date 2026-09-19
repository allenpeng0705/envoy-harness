/**
 * Session-log repair.
 *
 * Two ways a crash-corrupted log used to break `--resume`:
 *
 * 1. **A torn tail.** A crash mid-append can leave a partial final line
 *    (`{"role":"assis`). `PersistedSession.open` threw
 *    `invalid message at line N`, so the session became **permanently
 *    unopenable** — the worst possible outcome, since the transcript is
 *    the only copy of the work.
 *
 * 2. **A dangling tool call.** The `tool_call` was durably logged but the
 *    process died before the `tool_result`. The tool may already have
 *    run. On resume the provider rejects the transcript (OpenAI requires
 *    every `tool_call` to have a matching result), or — worse — a replay
 *    re-executes a side-effecting command.
 *
 * **The rule both fixes follow:** never silently drop information the
 * model needs, and never let it re-run a tool whose outcome is unknown.
 * A torn line is dropped with a counter (there is no way to interpret
 * half a record); a dangling call is *closed* with an explicit
 * "outcome unknown" result that tells the model what to do.
 *
 * Errors are reported, never swallowed: the caller decides whether to
 * warn, and the repair itself is recorded so a resumed session shows
 * what happened.
 */

import type { ContentBlock, Message, Role } from "../tools/types.js";

/** How a log was repaired when it was opened. */
export interface SessionRepairReport {
  /** A partial final line was discarded (crash mid-append). */
  readonly tornTail: boolean;
  /** Bytes discarded with the torn tail. */
  readonly tornBytes: number;
  /** Tool calls closed with an "outcome unknown" result. */
  readonly danglingToolCalls: number;
}

export const EMPTY_REPAIR_REPORT: SessionRepairReport = {
  tornTail: false,
  tornBytes: 0,
  danglingToolCalls: 0,
};

/**
 * Split raw file content into complete lines, discarding a partial tail.
 *
 * A well-formed JSONL file ends with `\n`. Anything after the last `\n`
 * is a partial record from a crash: it cannot be parsed and must not be
 * guessed at, so it is dropped and reported.
 */
export function splitCompleteLines(raw: string): {
  lines: string[];
  torn: string | undefined;
} {
  if (raw.length === 0) return { lines: [], torn: undefined };
  const endsCleanly = raw.endsWith("\n");
  const parts = raw.split("\n");
  // `split` yields a trailing "" for a file ending in "\n"; drop it.
  if (endsCleanly) parts.pop();
  if (endsCleanly) return { lines: parts, torn: undefined };
  const torn = parts.pop();
  return { lines: parts, torn: torn ?? "" };
}

/** The instruction attached to a synthesized result for a dangling call. */
export const UNKNOWN_OUTCOME_NOTICE =
  "This tool call was interrupted before its result was recorded, so its " +
  "outcome is UNKNOWN. It may or may not have taken effect. Do NOT retry it " +
  "blindly: retry only if the operation is read-only or idempotent; if it " +
  "may have had side effects, verify the external state first (or ask the user).";

/**
 * Close every `tool_call` that has no matching `tool_result`.
 *
 * Returns the (possibly extended) transcript plus the number of calls
 * closed. Matching is by `toolCallId`, scanning forward so a result
 * belongs to the nearest preceding call with that id.
 */
export function repairDanglingToolCalls(
  messages: ReadonlyArray<Message>,
): { messages: Message[]; repaired: number } {
  // **Conservatism guard.** If any `tool_result` lacks a `toolCallId`, the
  // transcript cannot tell us which call it belongs to, so we cannot
  // distinguish "the result was never written" from "the result is here
  // but unlabelled". Repairing then would append a spurious
  // "outcome unknown" error beside a real result. Older/partial logs
  // (and hand-written fixtures) do contain unlabelled results, so skip
  // repair entirely rather than corrupt them.
  for (const message of messages) {
    for (const block of message.content) {
      if (
        block.type === "tool_result" &&
        (typeof block.toolCallId !== "string" || block.toolCallId.length === 0)
      ) {
        return { messages: [...messages], repaired: 0 };
      }
    }
  }

  const pending = new Map<string, true>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call") pending.set(block.id, true);
      else if (block.type === "tool_result") pending.delete(block.toolCallId);
    }
  }
  if (pending.size === 0) {
    return { messages: [...messages], repaired: 0 };
  }

  const results: ContentBlock[] = [...pending.keys()].map((toolCallId) => ({
    type: "tool_result" as const,
    toolCallId,
    content: UNKNOWN_OUTCOME_NOTICE,
    isError: true,
  }));
  return {
    messages: [...messages, { role: "tool" as Role, content: results }],
    repaired: results.length,
  };
}

/**
 * Repair a loaded transcript in one pass: drop a torn tail, then close
 * dangling tool calls.
 *
 * `torn` handling happens at the line level by the caller (it owns the
 * raw bytes); this helper covers the parsed-message level and merges the
 * reports.
 */
export function repairLoadedTranscript(options: {
  raw: string;
  parse: (line: string) => Message;
  tornReport?: { tornBytes: number };
}): {
  messages: Message[];
  report: SessionRepairReport;
} {
  const { lines, torn } = splitCompleteLines(options.raw);
  const messages: Message[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    messages.push(options.parse(line));
  }
  const { messages: closed, repaired } = repairDanglingToolCalls(messages);
  return {
    messages: closed,
    report: {
      tornTail: torn !== undefined,
      tornBytes:
        torn === undefined
          ? 0
          : (options.tornReport?.tornBytes ??
            Math.max(0, Buffer.byteLength(torn, "utf8"))),
      danglingToolCalls: repaired,
    },
  };
}
