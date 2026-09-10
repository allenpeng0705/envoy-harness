/**
 * CLI argument parsing — public entry (module-size split).
 */

import type { ParsedArgs } from "./argv-types.js";
import { stripRunnerSeparators } from "./argv-normalize.js";
import { parseRunArgs } from "./argv-parse-run.js";
import { parseSelfEvolveArgs } from "./argv-parse-self-evolve.js";
import {
  parseDoctorArgs,
  parseMcpArgs,
  parseTeamArgs,
  parseTuiArgs,
  parseWebArgs,
} from "./argv-parse-subcommands.js";

export {
  ArgvError,
  type DoctorParsedArgs,
  type McpParsedArgs,
  type ParsedArgs,
  type RunParsedArgs,
  type SelfEvolveParsedArgs,
  type TeamParsedArgs,
  type TuiParsedArgs,
  type WebParsedArgs,
} from "./argv-types.js";
export { formatHelp } from "./argv-help.js";

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  // Normalize runner-injected `--` separators first: `pnpm envoy --
  // --repl` forwards the literal `--`, which no subcommand parser
  // accepts. See `argv-normalize.ts` for why this is safe.
  const normalized = stripRunnerSeparators(argv);

  // Detect subcommand: the first non-flag positional.
  const firstPositional = normalized.find((a) => !a.startsWith("--"));
  if (firstPositional === "self-evolve") {
    return parseSelfEvolveArgs(normalized);
  }
  if (firstPositional === "team") {
    return parseTeamArgs(normalized);
  }
  if (firstPositional === "doctor") {
    return parseDoctorArgs(normalized);
  }
  if (firstPositional === "mcp") {
    return parseMcpArgs(normalized);
  }
  if (firstPositional === "tui") {
    return parseTuiArgs(normalized);
  }
  if (firstPositional === "web") {
    return parseWebArgs(normalized);
  }
  return parseRunArgs(normalized);
}
