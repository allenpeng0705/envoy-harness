/**
 * CLI argument parsing — public entry (module-size split).
 */

import type { ParsedArgs } from "./argv-types.js";
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
  // Detect subcommand: the first non-flag positional.
  const firstPositional = argv.find((a) => !a.startsWith("--"));
  if (firstPositional === "self-evolve") {
    return parseSelfEvolveArgs(argv);
  }
  if (firstPositional === "team") {
    return parseTeamArgs(argv);
  }
  if (firstPositional === "doctor") {
    return parseDoctorArgs(argv);
  }
  if (firstPositional === "mcp") {
    return parseMcpArgs(argv);
  }
  if (firstPositional === "tui") {
    return parseTuiArgs(argv);
  }
  if (firstPositional === "web") {
    return parseWebArgs(argv);
  }
  return parseRunArgs(argv);
}
