/**
 * Wave 1 — adapter-backed remote compaction via `complete()`.
 *
 * Codex remote-compact V2-lite: ask the model to summarize the
 * transcript; return `{ summary }` for Agent.compactRemote.
 */

import type { Message, ModelAdapter } from "../model.js";
import {
  multimodalToolContentToText,
  normalizeToolResultContent,
} from "../tools/multimodal.js";

const REMOTE_COMPACT_SYSTEM =
  "You are a context compaction assistant. Summarize the conversation " +
  "for a future agent turn. Preserve: decisions and why they were made, " +
  "what those decisions superseded, key file paths, and open questions. " +
  "Use causal phrasing. Do not invent outcomes. Reply with the summary only.";

export async function remoteCompactViaComplete(
  adapter: Pick<ModelAdapter, "complete">,
  input: { messages: ReadonlyArray<Message>; signal?: AbortSignal },
): Promise<{ summary: string }> {
  const transcript = input.messages
    .map((m) => {
      const text = m.content
        .map((b) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_call") {
            return `[tool_call ${b.name} ${JSON.stringify(b.args)}]`;
          }
          if (b.type === "tool_result") {
            const flat = multimodalToolContentToText(
              normalizeToolResultContent(b.content),
            );
            return `[tool_result ${flat.slice(0, 500)}]`;
          }
          return `[${b.type}]`;
        })
        .join("\n");
      return `${m.role}: ${text}`;
    })
    .join("\n\n");

  const response = await adapter.complete({
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: REMOTE_COMPACT_SYSTEM }],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Compact the following transcript into a rolling summary:\n\n" +
              transcript.slice(0, 100_000),
          },
        ],
      },
    ],
    tools: [],
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const summary = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (summary.length === 0) {
    throw new Error("remoteCompact: model returned an empty summary");
  }
  return { summary };
}
