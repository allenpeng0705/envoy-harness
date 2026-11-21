/**
 * Composer attachment helpers (Wave 2).
 * Images → ACP image content blocks; other files → workspace/attach paths.
 */

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export interface DraftAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** base64 without data-URL prefix */
  dataBase64: string;
  kind: "image" | "file";
}

let attachSeq = 0;

function nextId(): string {
  attachSeq += 1;
  return `att-${attachSeq}`;
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export async function fileToDraftAttachment(
  file: File,
): Promise<DraftAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `${file.name} exceeds ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MiB limit`,
    );
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const dataBase64 = btoa(binary);
  const mimeType =
    file.type && file.type.length > 0 ? file.type : "application/octet-stream";
  return {
    id: nextId(),
    name: file.name || "file",
    mimeType,
    size: file.size,
    dataBase64,
    kind: isImageMime(mimeType) ? "image" : "file",
  };
}

export function buildPromptPayload(
  text: string,
  attachments: ReadonlyArray<DraftAttachment>,
  attachedPaths: ReadonlyArray<string>,
): {
  text: string;
  content?: PromptContentBlock[];
} {
  const pathLines = attachedPaths.map((p) => `Attached: ${p}`);
  const body = [text.trim(), ...pathLines].filter((s) => s.length > 0).join("\n");
  const images = attachments.filter((a) => a.kind === "image");
  if (images.length === 0) {
    return { text: body.length > 0 ? body : text };
  }
  const content: PromptContentBlock[] = [];
  if (body.length > 0) {
    content.push({ type: "text", text: body });
  }
  for (const img of images) {
    content.push({
      type: "image",
      mimeType: img.mimeType,
      data: img.dataBase64,
    });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: text || "(image)" });
  }
  return { text: body.length > 0 ? body : text || "(image)", content };
}

export function attachmentFootnote(
  attachments: ReadonlyArray<DraftAttachment>,
  paths: ReadonlyArray<string>,
): string {
  const parts: string[] = [];
  for (const a of attachments) {
    if (a.kind === "image") parts.push(`[image:${a.mimeType}]`);
  }
  for (const p of paths) parts.push(`[file:${p}]`);
  return parts.join(" ");
}
