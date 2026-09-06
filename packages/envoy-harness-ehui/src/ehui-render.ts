/**
 * R7.1 — structured panel body lines (CSS classes mirroring TUI views.ts).
 * No ANSI — hosts style `.ehui-line--*` in chat.css.
 */

export type EhuiLineKind =
  | "header"
  | "hint"
  | "body"
  | "diff-add"
  | "diff-del"
  | "diff-hunk"
  | "diff-meta"
  | "diff-ctx";

export interface EhuiLine {
  kind: EhuiLineKind;
  text: string;
}

export function buildPlanLines(text: string): EhuiLine[] {
  const header: EhuiLine = {
    kind: "header",
    text: "Plan (read-only · /plan edit)",
  };
  if (text.trim().length === 0) {
    return [header, { kind: "hint", text: "empty — use /plan enter" }];
  }
  return [
    header,
    ...text.split("\n").map((l): EhuiLine => ({ kind: "body", text: l })),
  ];
}

export function buildMemoryLines(text: string): EhuiLine[] {
  const header: EhuiLine = {
    kind: "header",
    text: "Memory ( /memory list | read | add )",
  };
  if (text.trim().length === 0) {
    return [header, { kind: "hint", text: "empty" }];
  }
  return [
    header,
    ...text.split("\n").map((l): EhuiLine => ({ kind: "body", text: l })),
  ];
}

export function buildGitDiffLines(text: string): EhuiLine[] {
  const header: EhuiLine = {
    kind: "header",
    text: "Git diff ( /diff --staged --stat )",
  };
  if (text.trim().length === 0) {
    return [header, { kind: "hint", text: "clean working tree" }];
  }
  const lines: EhuiLine[] = [header];
  for (const line of text.split("\n")) {
    let kind: EhuiLineKind = "diff-ctx";
    if (line.startsWith("+++") || line.startsWith("---")) {
      kind = "diff-meta";
    } else if (line.startsWith("+")) {
      kind = "diff-add";
    } else if (line.startsWith("-")) {
      kind = "diff-del";
    } else if (line.startsWith("@@")) {
      kind = "diff-hunk";
    }
    lines.push({ kind, text: line });
  }
  return lines;
}

export function ehuiLineClassName(kind: EhuiLineKind): string {
  return `ehui-line ehui-line--${kind}`;
}
