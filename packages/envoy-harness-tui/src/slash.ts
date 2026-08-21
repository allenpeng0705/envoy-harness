/**
 * Slash palette stub — local commands, not sent to the agent.
 */

export type SlashResult =
  | { kind: "help"; text: string }
  | { kind: "cancel" }
  | { kind: "quit" }
  | { kind: "unknown"; command: string };

const HELP = `Slash commands:
  /help     show this help
  /cancel   cancel the in-flight prompt
  /quit     exit the TUI
`;

/** Parse a line that starts with `/`. Non-slash input returns null. */
export function parseSlash(line: string): SlashResult | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const [cmd] = trimmed.slice(1).split(/\s+/);
  switch (cmd?.toLowerCase()) {
    case "help":
    case "?":
      return { kind: "help", text: HELP };
    case "cancel":
      return { kind: "cancel" };
    case "quit":
    case "exit":
    case "q":
      return { kind: "quit" };
    default:
      return { kind: "unknown", command: cmd ?? "" };
  }
}
