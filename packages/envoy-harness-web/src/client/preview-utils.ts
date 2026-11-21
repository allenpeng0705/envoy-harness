/**
 * Wave 9 / M7 — light preview helpers (not a full IDE).
 */

export function previewLanguage(path: string, mime?: string): string {
  if (mime?.startsWith("image/")) return "image";
  if (mime === "application/json") return "json";
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  switch (ext) {
    case "md":
    case "mdx":
      return "markdown";
    case "json":
      return "json";
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "yml":
    case "yaml":
      return "yaml";
    case "sh":
    case "bash":
      return "shell";
    case "toml":
      return "toml";
    default:
      return ext || "text";
  }
}

export function isMarkdownPreview(lang: string): boolean {
  return lang === "markdown";
}

/** Pretty-print JSON when possible; otherwise return original. */
export function maybePrettyJson(text: string, lang: string): string {
  if (lang !== "json") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function numberLines(text: string): Array<{ n: number; text: string }> {
  const lines = text.split("\n");
  return lines.map((line, i) => ({ n: i + 1, text: line }));
}
