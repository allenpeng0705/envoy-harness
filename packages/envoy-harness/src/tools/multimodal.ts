/**
 * Multimodal tool results — text plus optional base64 images so screenshot
 * / MCP image blocks reach the model as vision content (not placeholders).
 */

export interface ToolImageContent {
  /** MIME type, e.g. `image/png`. */
  mimeType: string;
  /** Raw base64 payload (no data: URL prefix). */
  data: string;
}

export interface MultimodalToolContent {
  text: string;
  images: ReadonlyArray<ToolImageContent>;
}

export function isMultimodalToolContent(
  value: unknown,
): value is MultimodalToolContent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v["text"] !== "string") return false;
  if (!Array.isArray(v["images"])) return false;
  return v["images"].every((img) => {
    if (img === null || typeof img !== "object") return false;
    const o = img as Record<string, unknown>;
    return typeof o["mimeType"] === "string" && typeof o["data"] === "string";
  });
}

/** Flatten multimodal content for hosts that only accept strings. */
export function multimodalToolContentToText(
  content: MultimodalToolContent,
): string {
  if (content.images.length === 0) return content.text;
  const notes = content.images.map(
    (img, i) =>
      `[image ${i + 1}: ${img.mimeType}, ${img.data.length} base64 chars — attached for vision]`,
  );
  const body = content.text.trim();
  return body.length > 0 ? `${body}\n${notes.join("\n")}` : notes.join("\n");
}

/** Normalize tool_result.content for LLM adapters. */
export function normalizeToolResultContent(content: unknown): {
  text: string;
  images: ReadonlyArray<ToolImageContent>;
} {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (isMultimodalToolContent(content)) {
    return { text: content.text, images: content.images };
  }
  try {
    return { text: JSON.stringify(content), images: [] };
  } catch {
    return { text: String(content), images: [] };
  }
}
