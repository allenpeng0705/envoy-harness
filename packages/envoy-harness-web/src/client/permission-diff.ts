/**
 * Wave 5 — browser-safe permission diff / path previews.
 * Mirrors TUI permission-preview patterns without Node fs
 * (optional before-text can be injected by the host via readFs).
 */

export interface PermissionDiffPreview {
  /** One-line label above the diff. */
  title: string;
  /** Unified-ish hunk text for a mono pane. */
  diff: string;
  /** True when this is a write/edit/patch style preview. */
  kind: "edit" | "write" | "patch" | "paths";
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)`;
}

function formatEditDiff(
  filePath: string,
  oldText: string,
  newText: string,
): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const out = [`--- ${filePath}`, `+++ ${filePath}`, "@@ edit @@"];
  for (const line of oldLines.slice(0, 10)) out.push(`- ${line}`);
  for (const line of newLines.slice(0, 10)) out.push(`+ ${line}`);
  if (oldLines.length > 10 || newLines.length > 10) out.push("…");
  return out.join("\n");
}

function formatWriteDiff(
  filePath: string,
  before: string | undefined,
  after: string,
): string {
  if (before === undefined) {
    return [`+++ new file ${filePath}`, truncateLines(after, 16)].join("\n");
  }
  const out = [`--- ${filePath}`, `+++ ${filePath}`, "@@ write @@"];
  for (const line of before.split("\n").slice(0, 8)) out.push(`- ${line}`);
  for (const line of after.split("\n").slice(0, 8)) out.push(`+ ${line}`);
  if (
    before.split("\n").length > 8 ||
    after.split("\n").length > 8
  ) {
    out.push("…");
  }
  return out.join("\n");
}

function asRecord(args: unknown): Record<string, unknown> | null {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return null;
}

/**
 * Build a readable diff/path preview from a permission prompt.
 * Pass `beforeContent` when the host already loaded the on-disk file.
 */
export function buildPermissionDiffPreview(
  toolName: string,
  args: unknown,
  beforeContent?: string,
): PermissionDiffPreview | null {
  const o = asRecord(args);
  if (o === null) return null;

  if (toolName === "edit") {
    const filePath = typeof o.path === "string" ? o.path : "?";
    const oldText = typeof o.oldText === "string" ? o.oldText : "";
    const newText = typeof o.newText === "string" ? o.newText : "";
    if (!oldText && !newText) return null;
    return {
      title: `edit ${filePath}`,
      kind: "edit",
      diff: formatEditDiff(filePath, oldText, newText),
    };
  }

  if (toolName === "write" && typeof o.path === "string") {
    const content = typeof o.content === "string" ? o.content : "";
    return {
      title: `write ${o.path}`,
      kind: "write",
      diff: formatWriteDiff(o.path, beforeContent, content),
    };
  }

  if (
    (toolName === "apply_patch" || toolName === "apply-patch") &&
    typeof o.patch === "string" &&
    o.patch.trim().length > 0
  ) {
    return {
      title: "apply_patch",
      kind: "patch",
      diff: truncateLines(o.patch, 40),
    };
  }

  // Path-ish tools: show paths as a compact list.
  const paths: string[] = [];
  for (const key of ["path", "file_path", "file", "cwd"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) paths.push(`${key}: ${v}`);
  }
  if (paths.length > 0 && (toolName === "read" || toolName === "bash" || toolName === "glob" || toolName === "grep")) {
    return {
      title: toolName,
      kind: "paths",
      diff: paths.join("\n"),
    };
  }

  return null;
}

/** Resolve a path argument for optional host readFs. */
export function permissionTargetPath(
  toolName: string,
  args: unknown,
): string | undefined {
  if (toolName !== "write" && toolName !== "edit") return undefined;
  const o = asRecord(args);
  if (o === null) return undefined;
  return typeof o.path === "string" && o.path.length > 0 ? o.path : undefined;
}
