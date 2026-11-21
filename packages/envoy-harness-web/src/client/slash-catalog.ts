/**
 * Slash command catalog for the web composer palette.
 * Offline fallback when ACP has not yet sent `available_commands_update`.
 *
 * Later deferrals: Cordis marketplace UI, full browser IDE panes.
 */

export interface SlashCatalogEntry {
  name: string;
  description: string;
}

/** Fallback palette mirroring TUI + common REPL-only names. */
export const FALLBACK_SLASH_CATALOG: ReadonlyArray<SlashCatalogEntry> = [
  { name: "help", description: "list slash commands" },
  { name: "status", description: "session id, busy state, last turn cost" },
  { name: "session", description: "show active session id" },
  { name: "compact", description: "compact session context" },
  { name: "cost", description: "last turn token cost" },
  { name: "context", description: "transcript size + last turn cost" },
  { name: "model", description: "show / swap model" },
  { name: "provider", description: "swap provider: /provider <name> [model]" },
  { name: "sandbox", description: "permission mode" },
  { name: "approval", description: "approval policy" },
  { name: "agents", description: "list / steer sub-agents" },
  { name: "memory", description: "memory: list | read | add" },
  { name: "plan", description: "plan document lifecycle" },
  { name: "mode", description: "collaboration mode: default | plan | review" },
  { name: "review", description: "model code review of git diff" },
  { name: "diff", description: "git diff" },
  { name: "git-status", description: "git status" },
  { name: "hooks", description: "list hooks" },
  { name: "mcp", description: "list MCP servers" },
  { name: "mesh", description: "mesh guide / connect" },
  { name: "peers", description: "list connected peers" },
  { name: "cluster", description: "cluster health" },
  { name: "team", description: "team jobs" },
  { name: "scoreboard", description: "peer reputation" },
  { name: "new", description: "new session" },
  { name: "clear", description: "clear transcript display" },
  { name: "rename", description: "rename session: /rename <title>" },
  { name: "export", description: "export transcript" },
  { name: "copy", description: "copy last assistant reply" },
  { name: "schedule", description: "schedules: list | create | tick" },
  { name: "goals", description: "goals: list | create" },
  { name: "plugins", description: "list plugins" },
  { name: "profile", description: "list / apply profiles" },
];

export function filterSlashCatalog(
  catalog: ReadonlyArray<SlashCatalogEntry>,
  draft: string,
): SlashCatalogEntry[] {
  const trimmed = draft.trimStart();
  if (!trimmed.startsWith("/")) return [];
  // Once args are present (`/schedule list`), close the palette so
  // Enter submits the slash line instead of re-autocompleting.
  if (/\s/.test(trimmed.slice(1))) return [];
  const token = trimmed.slice(1).split(/\s+/)[0] ?? "";
  const lower = token.toLowerCase();
  return catalog
    .filter((c) => c.name.toLowerCase().startsWith(lower))
    .slice(0, 12);
}

export type EnterBehavior = "enter-send" | "mod-enter-send";

export function readEnterBehavior(): EnterBehavior {
  try {
    const v = localStorage.getItem("eh-web-enter-behavior");
    return v === "mod-enter-send" ? "mod-enter-send" : "enter-send";
  } catch {
    return "enter-send";
  }
}

export function writeEnterBehavior(v: EnterBehavior): void {
  try {
    localStorage.setItem("eh-web-enter-behavior", v);
  } catch {
    // ignore
  }
}

export function readFontSizePx(): number {
  try {
    const n = Number(localStorage.getItem("eh-web-font-size"));
    return Number.isFinite(n) && n >= 12 && n <= 22 ? n : 15;
  } catch {
    return 15;
  }
}

export function writeFontSizePx(n: number): void {
  try {
    localStorage.setItem("eh-web-font-size", String(n));
  } catch {
    // ignore
  }
}
