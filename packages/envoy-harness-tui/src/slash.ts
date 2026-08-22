/**
 * Slash palette stub — local commands, not sent to the agent.
 */

export type SlashResult =
  | { kind: "help"; text: string }
  | { kind: "cancel" }
  | { kind: "peers" }
  | { kind: "cluster" }
  | { kind: "team" }
  | { kind: "scoreboard" }
  | { kind: "route"; tag: string }
  | { kind: "search"; term: string }
  | { kind: "trace" }
  | { kind: "quit" }
  | { kind: "unknown"; command: string };

/** The slash-command palette (for help + tab completion). */
export const SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "help", description: "show this help" },
  { name: "peers", description: "list connected peers (R3 peer surface)" },
  {
    name: "cluster",
    description: "cluster status: peer health + routing (U1)",
  },
  { name: "team", description: "running/finished team jobs (U1)" },
  { name: "scoreboard", description: "peer reputation per skill (U1)" },
  { name: "route", description: "preview routing: /route <capability tag>" },
  { name: "search", description: "search the transcript: /search <term>" },
  { name: "trace", description: "recent discovery/peer events" },
  { name: "cancel", description: "cancel the in-flight prompt" },
  { name: "quit", description: "exit the TUI" },
];

const HELP = `Slash commands:
${SLASH_COMMANDS.map((c) => `  /${c.name}  ${c.description}`).join("\n")}
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
    case "peers":
      return { kind: "peers" };
    case "cluster":
      return { kind: "cluster" };
    case "team":
      return { kind: "team" };
    case "scoreboard":
      return { kind: "scoreboard" };
    case "route": {
      const tag = trimmed.slice(cmd.length + 1).trim();
      if (tag.length === 0) {
        return { kind: "unknown", command: "route (usage: /route <tag>)" };
      }
      return { kind: "route", tag };
    }
    case "search": {
      const term = trimmed.slice(cmd.length + 1).trim();
      if (term.length === 0) {
        return { kind: "unknown", command: "search (usage: /search <term>)" };
      }
      return { kind: "search", term };
    }
    case "trace":
      return { kind: "trace" };
    case "quit":
    case "exit":
    case "q":
      return { kind: "quit" };
    default:
      return { kind: "unknown", command: cmd ?? "" };
  }
}
