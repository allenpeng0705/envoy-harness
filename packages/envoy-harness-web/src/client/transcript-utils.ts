/**
 * Group consecutive status/tool rows for foldable activity blocks.
 */

import type { ChatMessage } from "./acp/host.js";

export type TranscriptItem =
  | { kind: "message"; message: ChatMessage }
  | {
      kind: "activity";
      id: string;
      messages: ChatMessage[];
    };

export function groupTranscript(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "status" || m.role === "tool") {
      const group: ChatMessage[] = [];
      while (
        i < messages.length &&
        (messages[i]!.role === "status" || messages[i]!.role === "tool")
      ) {
        group.push(messages[i]!);
        i += 1;
      }
      items.push({
        kind: "activity",
        id: `act-${group[0]!.id}`,
        messages: group,
      });
      continue;
    }
    items.push({ kind: "message", message: m });
    i += 1;
  }
  return items;
}

/** Highlight common permission args without dumping full JSON first. */
export function permissionPreview(args: unknown): {
  summary: string[];
  raw: string;
} {
  const raw = JSON.stringify(args, null, 2);
  const summary: string[] = [];
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const o = args as Record<string, unknown>;
    for (const key of [
      "command",
      "cmd",
      "path",
      "file_path",
      "file",
      "cwd",
      "url",
      "query",
    ]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) {
        summary.push(`${key}: ${v}`);
      }
    }
  }
  return { summary, raw };
}
