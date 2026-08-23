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

/** Role label shown in the transcript margin. */
export function transcriptTag(role: TranscriptRole): string {
  switch (role) {
    case "user":
      return "you";
    case "assistant":
      return "agent";
    case "tool":
      return "tool";
    case "system":
      return "sys";
    case "status":
      return "···";
  }
}

/**
 * Format one transcript line for display (plain ANSI — no markdown engine).
 * Multi-line messages use a continued margin so code blocks and tool
 * output read like Claude Code / Codex transcripts.
 */
export function formatTranscriptLine(line: TranscriptLine): string {
  const tag = transcriptTag(line.role);
  const body = formatMessageBody(line.role, line.text);
  const lines = body.split("\n");
  if (lines.length === 0) return `[${tag}]`;
  const head = `[${tag}] ${lines[0]}`;
  if (lines.length === 1) return head;
  const indent =
    line.role === "tool"
      ? "    ⎿ "
      : line.role === "assistant"
        ? "      "
        : "    ";
  return [head, ...lines.slice(1).map((l) => `${indent}${l}`)].join("\n");
}

/** Render message body: light structure for tools + fenced code blocks. */
export function formatMessageBody(role: TranscriptRole, text: string): string {
  if (role === "tool") {
    return formatToolBody(text);
  }
  if (role === "assistant") {
    return formatAssistantBody(text);
  }
  return text;
}

function formatToolBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(empty tool result)";
  if (trimmed.includes("\n- ") && trimmed.includes("\n+ ")) {
    return trimmed
      .split("\n")
      .map((line) =>
        line.startsWith("-") || line.startsWith("+") || line.startsWith("@@")
          ? line
          : line,
      )
      .join("\n");
  }
  // Common agent denial / error strings — surface clearly.
  if (trimmed.startsWith("denied by user:")) {
    return `denied — ${trimmed.slice("denied by user:".length).trim()}`;
  }
  if (trimmed.startsWith("denied:")) {
    return trimmed;
  }
  return trimmed;
}

function formatAssistantBody(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("![") && trimmed.includes("](data:image/")) {
      const mime = trimmed.match(/data:([^;]+)/)?.[1] ?? "image";
      out.push(`[image: ${mime}]`);
      continue;
    }
    const fence = line.trimStart().startsWith("```");
    if (fence) {
      inFence = !inFence;
      out.push(inFence ? "┌─ code ─" : "└─");
      continue;
    }
    if (inFence) {
      out.push(`│ ${line}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function formatPermissionBlock(
  req: {
    toolName: string;
    description: string;
    args: unknown;
  },
  preview?: string,
): string {
  const lines = [`Allow tool \`${req.toolName}\`?`, req.description];
  const argsText = formatPermissionArgs(req.args);
  if (argsText.length > 0) {
    lines.push(argsText);
  }
  if (preview !== undefined && preview.trim().length > 0) {
    lines.push("--- preview ---", preview);
  }
  lines.push("Type allow or deny (a/y / d/n)");
  return lines.join("\n");
}

function formatPermissionArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") {
    return args.trim().length > 0 ? args : "";
  }
  try {
    const json = JSON.stringify(args, null, 2);
    return json === "{}" ? "" : json;
  } catch {
    return String(args);
  }
}
