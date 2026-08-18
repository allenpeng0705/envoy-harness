/**
 * argv parser for the envoy-harness CLI.
 *
 * **Design doc:** `docs/design.md` §19.
 *
 * **Phase 1+3 scope:** the v0 flag set for `envoy-harness` and
 * the `self-evolve` subcommand. We don't try to match every
 * flag from §19 in this chunk — the parser is designed to be
 * additive (new flags append to `KNOWN_FLAGS` without breaking
 * existing tests). The full §19 surface lands in later chunks.
 *
 * **Subcommand dispatch:** the first non-flag positional is
 * treated as a subcommand (`self-evolve` is the only one in
 * v0; `envoy-harness [prompt]` is the default / no-subcommand
 * form). The top-level `parseArgs` returns a discriminated
 * union; callers narrow on `subcommand`.
 *
 * **Why a hand-rolled parser?** `process.argv.slice(2)` is a
 * single line; a `commander` / `yargs` dependency is overkill
 * for v0. The parser is small enough to read in one screen.
 *
 * **Stability:** `ParsedArgs` is the public type. New fields
 * are additive (default to `undefined`).
 */

import type { PermissionMode } from "../types.js";

/** v0 flag set for the `run` subcommand (default). */
const RUN_FLAGS = new Set([
  "--help",
  "--version",
  "--json",
  "--sandbox",
  "--approval",
  "--model",
  "--provider",
  "--cwd",
  "--max-turns",
  "--max-cost-usd",
  "--resume",
  "--fork",
  "--plan",
  "--no-color",
  "--verbose",
  "--quiet",
]);

/** v0 flag set for the `self-evolve` subcommand. */
const SELF_EVOLVE_FLAGS = new Set([
  "--help",
  "--version",
  "--model",
  "--provider",
  "--scoreboard",
  "--snapshot-dir",
  "--benchmark",
  "--ruleset",
  "--agents-md",
  "--commit",
  "--recent-failures",
  "--no-color",
  "--verbose",
  "--quiet",
]);

/** A flag that takes a value (--flag value) for the run subcommand. */
const RUN_VALUED_FLAGS = new Set([
  "--sandbox",
  "--approval",
  "--model",
  "--provider",
  "--cwd",
  "--max-turns",
  "--max-cost-usd",
  "--resume",
  "--fork",
]);

/** A flag that takes a value for the self-evolve subcommand. */
const SELF_EVOLVE_VALUED_FLAGS = new Set([
  "--model",
  "--provider",
  "--scoreboard",
  "--snapshot-dir",
  "--benchmark",
  "--ruleset",
  "--agents-md",
  "--recent-failures",
]);

/** The shared flags used by every subcommand. */
const COMMON_FLAGS = new Set(["--help", "--version", "--no-color", "--verbose", "--quiet"]);

// ---------------------------------------------------------------------------
// ParsedArgs — discriminated union by subcommand
// ---------------------------------------------------------------------------

/** Args for the default `run` subcommand (no subcommand keyword). */
export interface RunParsedArgs {
  subcommand: "run";
  /** `--help`: print help and exit. */
  help: boolean;
  /** `--version`: print version and exit. */
  version: boolean;
  /** `--json`: machine-readable JSON Lines output (Phase 2). */
  json: boolean;
  /** `--sandbox <mode>`: permission mode. */
  sandbox: PermissionMode | undefined;
  /** `--approval <mode>`: ask-for-approval policy. */
  approval: string | undefined;
  /** `--model <id>`: model identifier (passed to the adapter). */
  model: string | undefined;
  /** `--provider <name>`: provider name (openai, anthropic, etc.). */
  provider: string | undefined;
  /** `--cwd <path>`: override the working directory. */
  cwd: string | undefined;
  /** `--max-turns <n>`: max iterations for the agent loop. */
  maxTurns: number | undefined;
  /** `--max-cost-usd <n>`: cost ceiling (Phase 2). */
  maxCostUsd: number | undefined;
  /** `--resume <session-id>`: resume a saved session. */
  resume: string | undefined;
  /** `--fork <session-id>`: fork a saved session. */
  fork: string | undefined;
  /** `--plan`: plan-only mode. */
  plan: boolean;
  /** `--no-color`: disable ANSI colors. */
  noColor: boolean;
  /** `--verbose`: print hook fires and validator verdicts. */
  verbose: boolean;
  /** `--quiet`: suppress human output, only stream-json. */
  quiet: boolean;
  /** Positional args: the prompt (or `-` for stdin, or a file path). */
  positional: string[];
}

/** Args for the `self-evolve` subcommand. */
export interface SelfEvolveParsedArgs {
  subcommand: "self-evolve";
  /** `--help`: print help and exit. */
  help: boolean;
  /** `--version`: print version and exit. */
  version: boolean;
  /** `--model <id>`: model identifier (passed to the adapter). */
  model: string | undefined;
  /** `--provider <name>`: provider name. */
  provider: string | undefined;
  /** `--scoreboard <path>`: scoreboard YAML file. */
  scoreboard: string | undefined;
  /** `--snapshot-dir <path>`: snapshot directory. */
  snapshotDir: string | undefined;
  /** `--benchmark <path>`: frozen benchmark YAML file. */
  benchmark: string | undefined;
  /** `--ruleset <path>`: live ruleset file (committed on `kept`). */
  ruleset: string | undefined;
  /** `--agents-md <path>`: user AGENTS.md (snapshotted, not edited in v0). */
  agentsMd: string | undefined;
  /** `--commit`: actually write the candidate on `kept` (default: shadow). */
  commit: boolean;
  /** `--recent-failures <n>`: number of recent entries to feed the prompt. */
  recentFailures: number | undefined;
  /** `--no-color`: disable ANSI colors. */
  noColor: boolean;
  /** `--verbose`: print hook fires and validator verdicts. */
  verbose: boolean;
  /** `--quiet`: suppress human output, only stream-json. */
  quiet: boolean;
}

export type ParsedArgs = RunParsedArgs | SelfEvolveParsedArgs;

/** Error thrown when argv parsing fails. Caught by the runner. */
export class ArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgvError";
  }
}

/**
 * Parse `argv` (typically `process.argv.slice(2)`) into a
 * `ParsedArgs` object. The first non-flag positional selects
 * the subcommand; `self-evolve` is the only one in v0.
 *
 * Unknown flags throw `ArgvError`; this is intentional — silent
 * acceptance of unknown flags would mask typos.
 */
export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  // Detect subcommand: the first non-flag positional.
  const firstPositional = argv.find((a) => !a.startsWith("--"));
  if (firstPositional === "self-evolve") {
    return parseSelfEvolveArgs(argv);
  }
  return parseRunArgs(argv);
}

// ---------------------------------------------------------------------------
// run subcommand (default)
// ---------------------------------------------------------------------------

function parseRunArgs(argv: ReadonlyArray<string>): RunParsedArgs {
  const out: RunParsedArgs = {
    subcommand: "run",
    help: false,
    version: false,
    json: false,
    sandbox: undefined,
    approval: undefined,
    model: undefined,
    provider: undefined,
    cwd: undefined,
    maxTurns: undefined,
    maxCostUsd: undefined,
    resume: undefined,
    fork: undefined,
    plan: false,
    noColor: false,
    verbose: false,
    quiet: false,
    positional: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (!RUN_FLAGS.has(arg)) {
        throw new ArgvError(`unknown flag: ${arg}`);
      }
      if (handleCommonFlag(arg, out)) continue;
      if (arg === "--json") {
        out.json = true;
        continue;
      }
      if (arg === "--plan") {
        out.plan = true;
        continue;
      }
      // Valued flags: consume the next arg.
      if (RUN_VALUED_FLAGS.has(arg)) {
        const value = argv[++i];
        if (value === undefined) {
          throw new ArgvError(`${arg} requires a value`);
        }
        switch (arg) {
          case "--sandbox":
            if (!isPermissionMode(value)) {
              throw new ArgvError(
                `invalid --sandbox: ${value} (expected read-only | workspace-write | danger-full-access)`,
              );
            }
            out.sandbox = value;
            break;
          case "--approval":
            out.approval = value;
            break;
          case "--model":
            out.model = value;
            break;
          case "--provider":
            out.provider = value;
            break;
          case "--cwd":
            out.cwd = value;
            break;
          case "--max-turns": {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) {
              throw new ArgvError(`invalid --max-turns: ${value}`);
            }
            out.maxTurns = n;
            break;
          }
          case "--max-cost-usd": {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) {
              throw new ArgvError(`invalid --max-cost-usd: ${value}`);
            }
            out.maxCostUsd = n;
            break;
          }
          case "--resume":
            out.resume = value;
            break;
          case "--fork":
            out.fork = value;
            break;
        }
        continue;
      }
      // Should be unreachable.
      throw new ArgvError(`unhandled flag: ${arg}`);
    }
    out.positional.push(arg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// self-evolve subcommand
// ---------------------------------------------------------------------------

function parseSelfEvolveArgs(argv: ReadonlyArray<string>): SelfEvolveParsedArgs {
  const out: SelfEvolveParsedArgs = {
    subcommand: "self-evolve",
    help: false,
    version: false,
    model: undefined,
    provider: undefined,
    scoreboard: undefined,
    snapshotDir: undefined,
    benchmark: undefined,
    ruleset: undefined,
    agentsMd: undefined,
    commit: false,
    recentFailures: undefined,
    noColor: false,
    verbose: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (!SELF_EVOLVE_FLAGS.has(arg)) {
        throw new ArgvError(`unknown flag: ${arg}`);
      }
      if (handleCommonFlag(arg, out)) continue;
      if (arg === "--commit") {
        out.commit = true;
        continue;
      }
      if (SELF_EVOLVE_VALUED_FLAGS.has(arg)) {
        const value = argv[++i];
        if (value === undefined) {
          throw new ArgvError(`${arg} requires a value`);
        }
        switch (arg) {
          case "--model":
            out.model = value;
            break;
          case "--provider":
            out.provider = value;
            break;
          case "--scoreboard":
            out.scoreboard = value;
            break;
          case "--snapshot-dir":
            out.snapshotDir = value;
            break;
          case "--benchmark":
            out.benchmark = value;
            break;
          case "--ruleset":
            out.ruleset = value;
            break;
          case "--agents-md":
            out.agentsMd = value;
            break;
          case "--recent-failures": {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) {
              throw new ArgvError(`invalid --recent-failures: ${value}`);
            }
            out.recentFailures = n;
            break;
          }
        }
        continue;
      }
      throw new ArgvError(`unhandled flag: ${arg}`);
    }
    // For self-evolve, the only non-flag positional is the
    // subcommand keyword itself ("self-evolve"), which we've
    // already used to dispatch. Anything else is an error.
    if (arg !== "self-evolve") {
      throw new ArgvError(`unexpected positional: ${arg}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Handle flags common to all subcommands: --help, --version,
 * --no-color, --verbose, --quiet. Returns `true` if handled
 * (caller should continue), `false` otherwise.
 */
function handleCommonFlag(
  arg: string,
  out: { help: boolean; version: boolean; noColor: boolean; verbose: boolean; quiet: boolean },
): boolean {
  if (arg === "--help") {
    out.help = true;
    return true;
  }
  if (arg === "--version") {
    out.version = true;
    return true;
  }
  if (arg === "--no-color") {
    out.noColor = true;
    return true;
  }
  if (arg === "--verbose") {
    out.verbose = true;
    return true;
  }
  if (arg === "--quiet") {
    out.quiet = true;
    return true;
  }
  return false;
}

function isPermissionMode(value: string): value is PermissionMode {
  return (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  );
}

// Silence the "unused" warning for COMMON_FLAGS — it's kept as
// documentation of the shared surface; the actual handling is
// in `handleCommonFlag`.
void COMMON_FLAGS;

/** Print the help text to stderr (or wherever `out` points). */
export function formatHelp(version: string): string {
  return [
    `envoy-harness ${version}`,
    "",
    "Usage:",
    "  envoy-harness [flags] [prompt]",
    "  envoy-harness [flags] -                    # read prompt from stdin",
    "  envoy-harness [flags] <prompt-file>        # read prompt from a file",
    "  envoy-harness self-evolve [flags]          # run one self-evolution cycle",
    "",
    "Flags (run):",
    "  --sandbox <mode>       read-only | workspace-write | danger-full-access",
    "  --approval <mode>      unless-trusted | on-request | granular | never",
    "  --model <id>           LLM model identifier",
    "  --provider <name>      LLM provider (openai, anthropic, ollama, custom)",
    "  --cwd <path>           override working directory",
    "  --max-turns <n>        agent loop iteration cap (default 50)",
    "  --max-cost-usd <n>     cost ceiling (default 5.00)",
    "  --resume <session-id>  resume a previous session",
    "  --fork <session-id>    fork a previous session",
    "  --plan                 read + plan only, no writes",
    "  --json                 JSON Lines output (machine-readable)",
    "  --quiet                suppress human output",
    "  --no-color             disable ANSI colors",
    "  --verbose              print hook fires and validator verdicts",
    "  --help                 print this help and exit",
    "  --version              print version and exit",
    "",
    "Flags (self-evolve):",
    "  --scoreboard <path>    scoreboard YAML file",
    "  --snapshot-dir <path>  snapshot directory",
    "  --benchmark <path>     frozen benchmark YAML file",
    "  --ruleset <path>       live ruleset file (committed on kept)",
    "  --agents-md <path>     user AGENTS.md (snapshotted)",
    "  --commit               actually write the candidate (default: shadow)",
    "  --recent-failures <n>  recent entries to feed the prompt (default 20)",
    "",
    "See docs/design.md §19 for the full surface.",
  ].join("\n");
}
