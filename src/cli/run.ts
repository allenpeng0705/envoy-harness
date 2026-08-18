/**
 * CLI runner — the `envoy-harness` entry point.
 *
 * **Design doc:** `docs/design.md` §19.
 *
 * **What this module does:**
 *
 * 1. Parses argv (via `parseArgs`).
 * 2. Resolves the prompt (positional arg, `-` for stdin, or a
 *    file path). Phase 1 supports positional only; stdin / file
 *    land in a later chunk.
 * 3. Builds an `Agent` with the configured model, tools, session,
 *    and hooks.
 * 4. Runs the loop and prints the result.
 *
 * **What this module does NOT do (yet):**
 *
 * - REPL (slash commands, interactive). Phase 1 is single-shot.
 * - JSON Lines streaming. `--json` is accepted but ignored.
 * - Resume / fork. `--resume` and `--fork` are accepted but ignored
 *   until persistence lands in Phase 2.
 * - Provider dispatch. v0 takes a model adapter via dependency
 *   injection; the bin script wires the default (production)
 *   adapter.
 *
 * **Why a function (not a class)?** the run is one-shot; there's
 * no state to keep. A class would just hide the parameters in
 * `this`.
 *
 * **Stability:** `RunOptions` is the public API. Additive.
 */

import { promises as fs } from "node:fs";

import {
  Agent,
  BUILTIN_TOOLS,
  HookRegistry,
  InMemorySession,
  newSessionId,
  ToolRegistry,
  VERSION,
  type ModelAdapter,
  type Session,
  type SessionMetadata,
} from "../index.js";
import { formatHelp, parseArgs, type ParsedArgs } from "./argv.js";

/** Options the runner accepts. The bin script and tests both
 *  pass a `model` so the runner is provider-agnostic. */
export interface RunOptions {
  /** The argv to parse. Default: `process.argv.slice(2)`. */
  argv?: ReadonlyArray<string>;
  /** The model adapter. Default: throw (v0 requires explicit
   *  injection — there's no built-in provider in Phase 1). */
  model?: ModelAdapter;
  /** A hook registry. Default: a fresh `HookRegistry()`. */
  hooks?: HookRegistry;
  /** The cwd. Default: `process.cwd()`. */
  cwd?: string;
  /** Where to write the human-readable result. Default: stdout. */
  stdout?: NodeJS.WritableStream;
  /** Where to write errors / status. Default: stderr. */
  stderr?: NodeJS.WritableStream;
}

/** Result of a successful run. */
export interface RunResult {
  /** The agent's final content. */
  content: string;
  /** The agent's stop reason. */
  stopReason: string;
  /** The session id. */
  sessionId: string;
  /** Number of agent loop iterations. */
  iterations: number;
  /** Number of tool calls executed. */
  toolCalls: number;
}

/** The process exit code. */
export type ExitCode = 0 | 1 | 2 | 64 | 65 | 66;

export const EXIT_OK: ExitCode = 0;
export const EXIT_ERROR: ExitCode = 1;
export const EXIT_USAGE: ExitCode = 64; // EX_USAGE
export const EXIT_DATAERR: ExitCode = 65; // EX_DATAERR
export const EXIT_NOINPUT: ExitCode = 66; // EX_NOINPUT

/**
 * Run the CLI. Returns a `RunResult` on success, or throws
 * `CliError` on usage / runtime errors. The bin script catches
 * the error and sets the exit code.
 */
export async function run(
  options: RunOptions = {},
): Promise<RunResult> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  // 1. Parse argv.
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    throw new CliError(
      (err as Error).message,
      EXIT_USAGE,
    );
  }

  // 2. Handle --help / --version.
  if (parsed.help) {
    stdout.write(formatHelpText() + "\n");
    return {
      content: "",
      stopReason: "end_turn",
      sessionId: "",
      iterations: 0,
      toolCalls: 0,
    };
  }
  if (parsed.version) {
    stdout.write(`${VERSION}\n`);
    return {
      content: "",
      stopReason: "end_turn",
      sessionId: "",
      iterations: 0,
      toolCalls: 0,
    };
  }

  // 3. Resolve the prompt.
  const prompt = await resolvePrompt(parsed, stderr);
  if (prompt === null) {
    throw new CliError("no prompt provided (pass it as an argument)", EXIT_USAGE);
  }

  // 4. Model is required in v0.
  if (!options.model) {
    throw new CliError(
      "no model adapter configured (this is a v0 limitation; wire a real adapter in the bin script)",
      EXIT_USAGE,
    );
  }

  // 5. Build the agent.
  const cwd = parsed.cwd ?? options.cwd ?? process.cwd();
  const meta: SessionMetadata = {
    cwd,
    permissionMode: parsed.sandbox ?? "workspace-write",
    startedAt: new Date().toISOString(),
    title: prompt.slice(0, 60),
  };
  const session: Session = new InMemorySession(newSessionId(), meta);
  const tools = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) tools.register(t);
  const hooks = options.hooks ?? new HookRegistry();

  // exactOptionalPropertyTypes: only include maxTurns when set.
  const agentOptions: ConstructorParameters<typeof Agent>[0] = {
    model: options.model,
    tools,
    session,
    hooks,
    cwd,
  };
  if (parsed.maxTurns !== undefined) {
    agentOptions.maxIterations = parsed.maxTurns;
  }
  const agent = new Agent(agentOptions);

  // 6. Run the loop.
  const result = await agent.run(prompt);

  // 7. Print the result.
  const text = result.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!parsed.quiet) {
    stdout.write(text + "\n");
  }

  return {
    content: text,
    stopReason: result.stopReason,
    sessionId: session.id,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
  };
}

/**
 * Resolve the prompt from the positional argv. Returns `null` if
 * no prompt was provided. The first positional arg is the prompt
 * (or `-` for stdin, or a file path; in v0 only the literal prompt
 * is supported).
 */
async function resolvePrompt(
  parsed: ParsedArgs,
  _stderr: NodeJS.WritableStream,
): Promise<string | null> {
  if (parsed.positional.length === 0) return null;
  const first = parsed.positional[0];
  if (first === undefined) return null;
  if (first === "-") {
    // Read all of stdin.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  // Heuristic: if it looks like a file path AND the file exists,
  // read it. Otherwise treat it as a literal prompt.
  if (
    (first.startsWith("/") || first.startsWith("./") || first.startsWith("../")) &&
    await isFile(first)
  ) {
    return (await fs.readFile(first, "utf8")).trim();
  }
  // Treat the whole positional as the prompt (joined by spaces).
  return parsed.positional.join(" ");
}

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Help text — delegates to argv's `formatHelp` to keep one source. */
function formatHelpText(): string {
  return formatHelp(VERSION);
}

/** Error type thrown by the runner. Carries the exit code. */
export class CliError extends Error {
  constructor(message: string, public exitCode: ExitCode) {
    super(message);
    this.name = "CliError";
  }
}
