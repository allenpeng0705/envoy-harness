/**
 * Flatten persisted transcript messages into UI-friendly rows for WebUI/TUI.
 */

import type { ContentBlock, Message, Role } from "../tools/types.js";

export interface ProtocolUiMessage {
  role: "user" | "assistant" | "system" | "tool";
  text: string;
}

function blockToText(block: ContentBlock): string | undefined {
  if (block.type === "text") {
    return block.text;
  }
  if (block.type === "tool_call") {
    const args =
      typeof block.args === "object" && block.args !== null
        ? JSON.stringify(block.args)
        : String(block.args ?? "");
    const clipped = args.length > 120 ? `${args.slice(0, 117)}…` : args;
    return `⚙ ${block.name}(${clipped})`;
  }
  if (block.type === "tool_result") {
    const body =
      typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content);
    const clipped = body.length > 200 ? `${body.slice(0, 197)}…` : body;
    return block.isError ? `tool error: ${clipped}` : clipped;
  }
  if (block.type === "image") {
    return `[image ${block.mimeType}]`;
  }
  return undefined;
}

function roleToUi(role: Role): ProtocolUiMessage["role"] {
  if (role === "tool") return "tool";
  if (role === "system") return "system";
  if (role === "assistant") return "assistant";
  return "user";
}

/** Convert agent transcript messages into plain UI rows. */
export function messagesToUiTranscript(
  messages: ReadonlyArray<Message>,
): ProtocolUiMessage[] {
  const out: ProtocolUiMessage[] = [];
  for (const m of messages) {
    const parts: string[] = [];
    for (const block of m.content) {
      const t = blockToText(block);
      if (t !== undefined && t.length > 0) parts.push(t);
    }
    const text = parts.join("\n").trim();
    if (text.length === 0) continue;
    out.push({ role: roleToUi(m.role), text });
  }
  return out;
}
