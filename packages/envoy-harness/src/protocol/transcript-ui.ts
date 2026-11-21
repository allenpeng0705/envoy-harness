/**
 * Flatten persisted transcript messages into UI-friendly rows for WebUI/TUI.
 */

import {
  multimodalToolContentToText,
  normalizeToolResultContent,
  type ToolImageContent,
} from "../tools/multimodal.js";
import type { ContentBlock, Message, Role } from "../tools/types.js";

export interface ProtocolUiImage {
  mimeType: string;
  data: string;
}

export interface ProtocolUiMessage {
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  /** Vision images from multimodal tool results (e.g. device_screenshot). */
  images?: ReadonlyArray<ProtocolUiImage>;
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
    const body = multimodalToolContentToText(
      normalizeToolResultContent(block.content),
    );
    const clipped = body.length > 200 ? `${body.slice(0, 197)}…` : body;
    return block.isError ? `tool error: ${clipped}` : clipped;
  }
  if (block.type === "image") {
    return `[image ${block.mimeType}]`;
  }
  return undefined;
}

function imagesFromBlock(block: ContentBlock): ToolImageContent[] {
  if (block.type === "image") {
    return [{ mimeType: block.mimeType, data: block.data }];
  }
  if (block.type === "tool_result") {
    return [...normalizeToolResultContent(block.content).images];
  }
  return [];
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
    const images: ProtocolUiImage[] = [];
    for (const block of m.content) {
      const t = blockToText(block);
      if (t !== undefined && t.length > 0) parts.push(t);
      for (const img of imagesFromBlock(block)) {
        images.push({ mimeType: img.mimeType, data: img.data });
      }
    }
    const text = parts.join("\n").trim();
    if (text.length === 0 && images.length === 0) continue;
    out.push({
      role: roleToUi(m.role),
      text: text.length > 0 ? text : "(image)",
      ...(images.length > 0 ? { images } : {}),
    });
  }
  return out;
}
