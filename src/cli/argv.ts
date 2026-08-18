/**
 * argv parser for the envoy-harness CLI.
 *
 * **Design doc:** `docs/design.md` §19.
 *
 * **Phase 1 scope:** the v0 flag set. We don't try to match every
 * flag from §19 in this chunk — the parser is designed to be
 * additive (new flags append to `KNOWN_FLAGS` without breaking
 * existing tests). The full §19 surface lands in later chunks.
 *
 * **Why a hand-rolled parser?** `process.argv.slice(2)` is a
 * single line; a `commander` / `yargs` dependency is overkill
 * for v0. The parser is small enough to read in one screen.
 *
 * **Stability:** `ParsedArgs` is the public type. New fields
 * are additive (default to `undefined`).
 */

import type { PermissionMode } from "../types.js";

/** v0 flag set. Additive: new flags are appended, not reordered. */
const KNOWN_FLAGS = new Set([
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

/** A flag that takes a value (--flag value). */
const VALUED_FLAGS = new Set([
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

export interface ParsedArgs {
  /** `--help`: print help and exit. */
  help: boolean;
  /** `--version`: print version and exit. */
  version: boolean;
  /** `--json`: machine-readable JSON Lines output (Phase 2). */
  json: boolean;
  /** `--sandbox <mode>`: permission mode. */
  sandbox: PermissionMode | undefined;
  /** `--approval <mode>`: ask-for-approval policy (Phase 1: accepted, ignored for now). */
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
  /** `--plan`: plan-only mode (read + plan, no writes). Phase 2. */
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

/** Error thrown when argv parsing fails. Caught by the runner. */
export class ArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgvError";
  }
}

/**
 * Parse `argv` (typically `process.argv.slice(2)`) into a
 * `ParsedArgs` object. Unknown flags throw `ArgvError`; this
 * is intentional — silent acceptance of unknown flags would
 * mask typos.
 */
export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const out: ParsedArgs = {
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
      if (!KNOWN_FLAGS.has(arg)) {
        throw new ArgvError(`unknown flag: ${arg}`);
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
      if (arg === "--plan") {
        out.plan = true;
        continue;
      }
      if (arg === "--no-color") {
        out.noColor = true;
        continue;
      }
      if (arg === "--verbose") {
        out.verbose = true;
        continue;
      }
      if (arg === "--quiet") {
        out.quiet = true;
        continue;
      }
      // Valued flags: consume the next arg.
      if (VALUED_FLAGS.has(arg)) {
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

function isPermissionMode(value: string): value is PermissionMode {
  return (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  );
}

/** Print the help text to stderr (or wherever `out` points). */
export function formatHelp(version: string): string {
  return [
    `envoy-harness ${version}`,
    "",
    "Usage:",
    "  envoy-harness [flags] [prompt]",
    "  envoy-harness [flags] -                    # read prompt from stdin",
    "  envoy-harness [flags] <prompt-file>        # read prompt from a file",
    "",
    "Flags:",
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
    "See docs/design.md §19 for the full surface.",
  ].join("\n");
}
