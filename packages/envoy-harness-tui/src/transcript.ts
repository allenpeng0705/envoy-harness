/**
 * Transcript line shown in the TUI (committed messages only).
 */

export type TranscriptRole =
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "status";

export interface TranscriptLine {
  role: TranscriptRole;
  text: string;
  at: string;
}

export function formatTranscriptLine(line: TranscriptLine): string {
  const tag =
    line.role === "user"
      ? "you"
      : line.role === "assistant"
        ? "agent"
        : line.role === "tool"
          ? "tool"
          : line.role === "system"
            ? "sys"
            : "···";
  return `[${tag}] ${line.text}`;
}
