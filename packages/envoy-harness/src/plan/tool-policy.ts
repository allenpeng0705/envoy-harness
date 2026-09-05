/**
 * R4.6 — tool allow/deny matrices per collaboration mode.
 */

import type { ModeKind } from "./mode-kind.js";

/** Tools that mutate workspace or spawn long-running side effects. */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "task",
  "job_start",
  "job_kill",
  "terminal_open",
  "terminal_send",
  "terminal_signal",
  "terminal_close",
]);

/** Review mode: read / verify heavy allowlist (plus non-mutating builtins). */
export const REVIEW_ALLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "git",
  "bash",
  "ask_user",
  "session_query",
  "suggest_follow_ups",
  "enter_plan_mode",
  "exit_plan_mode",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_diagnostics",
  "web_search",
  "web_fetch",
  "skill",
  "skill_list",
]);

/**
 * Whether a tool may run in the given mode.
 * Returns an error message when blocked, else `undefined`.
 */
export function collaborationModeBlockReason(
  kind: ModeKind,
  toolName: string,
): string | undefined {
  if (kind === "default") return undefined;

  if (MUTATING_TOOL_NAMES.has(toolName)) {
    return `blocked by collaboration mode (${kind}): ${toolName} is not allowed`;
  }

  if (kind === "review") {
    if (
      !REVIEW_ALLOW_TOOL_NAMES.has(toolName) &&
      !toolName.startsWith("mcp__")
    ) {
      return `blocked by collaboration mode (review): ${toolName} is not on the review allowlist`;
    }
  }

  return undefined;
}

/** Filter tool definitions for the model (visibility). */
export function filterToolNamesForMode(
  names: ReadonlyArray<string>,
  kind: ModeKind,
): string[] {
  return names.filter(
    (name) => collaborationModeBlockReason(kind, name) === undefined,
  );
}

export function modeForcesReadOnly(kind: ModeKind): boolean {
  return kind === "plan" || kind === "review";
}
