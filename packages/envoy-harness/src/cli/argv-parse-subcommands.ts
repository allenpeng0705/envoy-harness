/**
 * team / mcp / doctor / tui / web argv parsers.
 */

import {
  ArgvError,
  type TeamParsedArgs,
  type McpParsedArgs,
  type DoctorParsedArgs,
  type TuiParsedArgs,
  type WebParsedArgs,
} from "./argv-types.js";

// ---------------------------------------------------------------------------
// team subcommand (F9.3)
// ---------------------------------------------------------------------------

const TEAM_FLAGS = new Set([
  "--model",
  "--provider",
  "--base-url",
  "--cwd",
  "--input",
  "--json",
  "--quiet",
  "--help",
  "--version",
]);

export function parseTeamArgs(argv: ReadonlyArray<string>): TeamParsedArgs {
  const out: TeamParsedArgs = {
    subcommand: "team",
    help: false,
    version: false,
    model: undefined,
    provider: undefined,
    baseUrl: undefined,
    cwd: undefined,
    input: undefined,
    json: false,
    quiet: false,
    positional: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (!TEAM_FLAGS.has(arg)) {
        throw new ArgvError(`unknown flag for team subcommand: ${arg}`);
      }
      if (arg === "--help") {
        out.help = true;
        continue;
      }
      if (arg === "--version") {
        out.version = true;
        continue;
      }
      if (arg === "--json") {
        out.json = true;
        continue;
      }
      if (arg === "--quiet") {
        out.quiet = true;
        continue;
      }
      // Valued flags: consume the next arg.
      const next = argv[i + 1];
      if (next === undefined) {
        throw new ArgvError(`flag ${arg} requires a value`);
      }
      if (arg === "--model") out.model = next;
      else if (arg === "--provider") out.provider = next;
      else if (arg === "--base-url") out.baseUrl = next;
      else if (arg === "--cwd") out.cwd = next;
      else if (arg === "--input") out.input = next;
      i++;
      continue;
    }
    // Strip the "team" subcommand keyword from
    // the positional list.
    if (arg === "team") continue;
    out.positional.push(arg);
  }

  return out;
}

export function parseMcpArgs(argv: ReadonlyArray<string>): McpParsedArgs {
  const out: McpParsedArgs = {
    subcommand: "mcp",
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "mcp") continue;
    if (arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "--version") {
      out.version = true;
      continue;
    }
    if (arg === "--cwd") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new ArgvError("--cwd requires a path");
      }
      out.cwd = next;
      i++;
      continue;
    }
    throw new ArgvError(`unknown flag for mcp subcommand: ${arg}`);
  }
  return out;
}

export function parseDoctorArgs(argv: ReadonlyArray<string>): DoctorParsedArgs {
  const out: DoctorParsedArgs = {
    subcommand: "doctor",
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "doctor") continue;
    if (arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "--version") {
      out.version = true;
      continue;
    }
    if (arg === "--config") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new ArgvError("flag --config requires a value");
      }
      out.config = next;
      i++;
      continue;
    }
    throw new ArgvError(`unknown flag for doctor subcommand: ${arg}`);
  }
  return out;
}

const TUI_FLAGS = new Set([
  "--demo",
  "--spawn",
  "--cluster-only",
  "--peers",
  "--connect-timeout-ms",
  "--provider",
  "--model",
  "--base-url",
  "--ask-permission",
  "--help",
  "-h",
  "--no-color",
]);

export function parseTuiArgs(argv: ReadonlyArray<string>): TuiParsedArgs {
  const out: TuiParsedArgs = {
    subcommand: "tui",
    help: false,
    version: false,
    noColor: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "tui") continue;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--version") {
      out.version = true;
      continue;
    }
    if (arg === "--no-color") {
      out.noColor = true;
      continue;
    }
    if (!TUI_FLAGS.has(arg)) {
      throw new ArgvError(`unknown flag for tui subcommand: ${arg}`);
    }
    if (
      arg === "--peers" ||
      arg === "--connect-timeout-ms" ||
      arg === "--provider" ||
      arg === "--model" ||
      arg === "--base-url"
    ) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new ArgvError(`${arg} requires a value`);
      }
      i++;
    }
  }
  return out;
}

const WEB_FLAGS = new Set([
  "--port",
  "--host",
  "--cwd",
  "--provider",
  "--model",
  "--base-url",
  "--persist",
  "--no-subagents",
  "--peers",
  "--dev",
  "--no-open",
  "--help",
  "-h",
]);

export function parseWebArgs(argv: ReadonlyArray<string>): WebParsedArgs {
  const out: WebParsedArgs = {
    subcommand: "web",
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "web") continue;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--version") {
      out.version = true;
      continue;
    }
    if (!WEB_FLAGS.has(arg)) {
      throw new ArgvError(`unknown flag for web subcommand: ${arg}`);
    }
    if (
      arg === "--persist" ||
      arg === "--no-subagents" ||
      arg === "--dev" ||
      arg === "--no-open"
    ) {
      continue;
    }
    if (
      arg === "--port" ||
      arg === "--host" ||
      arg === "--cwd" ||
      arg === "--provider" ||
      arg === "--model" ||
      arg === "--base-url" ||
      arg === "--peers"
    ) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new ArgvError(`${arg} requires a value`);
      }
      i++;
    }
  }
  return out;
}
