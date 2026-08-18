/**
 * CLI runner — the `envoy-harness` entry point.
 *
 * **Design doc:** `docs/design.md` §19.
 *
 * **What this module does:**
 *
 * 1. Parses argv (via `parseArgs`) — dispatches to the
 *    `run` or `self-evolve` subcommand handler.
 * 2. For `run`: resolves the prompt, builds an `Agent`, runs
 *    the loop, prints the result.
 * 3. For `self-evolve`: builds a `SelfEvolve`, runs one cycle,
 *    prints the scoreboard entry.
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
import * as path from "node:path";

import {
  Agent,
  BUILTIN_TOOLS,
  DefaultBenchmarkRunner,
  HookRegistry,
  InMemorySession,
  ModelHypothesisProvider,
  newSessionId,
  SelfEvolve,
  ToolRegistry,
  VERSION,
  DEFAULT_RULES,
  type ModelAdapter,
  type Session,
  type SelfEvolvePaths,
  type SessionMetadata,
  type VerifierRule,
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

/** Result of a successful `run` invocation. */
export interface RunResult {
  /** Discriminator for the union (`CliRunResult`). */
  subcommand: "run";
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

/** Result of a successful `self-evolve` invocation. */
export interface SelfEvolveRunResult {
  /** Discriminator for the union (`CliRunResult`). */
  subcommand: "self-evolve";
  /** Whether the cycle's candidate was kept (would have been, in shadow mode). */
  kept: boolean;
  /** The scoreboard entry written by the cycle. */
  version: number;
  hypothesis: string;
  status: "kept" | "reverted";
  passRateBefore: number;
  passRateAfter: number;
  nRuns: number;
  rulesetHash: string;
}

/** Union of the two subcommand results. */
export type CliRunResult = RunResult | SelfEvolveRunResult;

/** The process exit code. */
export type ExitCode = 0 | 1 | 2 | 64 | 65 | 66;

export const EXIT_OK: ExitCode = 0;
export const EXIT_ERROR: ExitCode = 1;
export const EXIT_USAGE: ExitCode = 64; // EX_USAGE
export const EXIT_DATAERR: ExitCode = 65; // EX_DATAERR
export const EXIT_NOINPUT: ExitCode = 66; // EX_NOINPUT

/**
 * Run the CLI. Returns a `CliRunResult` on success, or throws
 * `CliError` on usage / runtime errors. The bin script catches
 * the error and sets the exit code.
 */
export async function run(
  options: RunOptions = {},
): Promise<CliRunResult> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  // 1. Parse argv.
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    throw new CliError((err as Error).message, EXIT_USAGE);
  }

  // 2. Handle --help / --version (common to all subcommands).
  if (parsed.help) {
    stdout.write(formatHelpText() + "\n");
    return makeEmptyRunResult();
  }
  if (parsed.version) {
    stdout.write(`${VERSION}\n`);
    return makeEmptyRunResult();
  }

  // 3. Dispatch on subcommand.
  if (parsed.subcommand === "self-evolve") {
    return runSelfEvolve(parsed, options, stdout, stderr);
  }
  return runAgent(parsed, options, stdout, stderr);
}

// ---------------------------------------------------------------------------
// run subcommand (default)
// ---------------------------------------------------------------------------

async function runAgent(
  parsed: Extract<ParsedArgs, { subcommand: "run" }>,
  options: RunOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<RunResult> {
  void stderr; // reserved for future use (e.g. verbose log)
  // 1. Resolve the prompt.
  const prompt = await resolvePrompt(parsed);
  if (prompt === null) {
    throw new CliError(
      "no prompt provided (pass it as an argument)",
      EXIT_USAGE,
    );
  }

  // 2. Model is required in v0.
  if (!options.model) {
    throw new CliError(
      "no model adapter configured (this is a v0 limitation; wire a real adapter in the bin script)",
      EXIT_USAGE,
    );
  }

  // 3. Build the agent.
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

  // 4. Run the loop.
  const result = await agent.run(prompt);

  // 5. Print the result.
  const text = result.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!parsed.quiet) {
    stdout.write(text + "\n");
  }

  return {
    subcommand: "run",
    content: text,
    stopReason: result.stopReason,
    sessionId: session.id,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
  };
}

// ---------------------------------------------------------------------------
// self-evolve subcommand
// ---------------------------------------------------------------------------

async function runSelfEvolve(
  parsed: Extract<ParsedArgs, { subcommand: "self-evolve" }>,
  options: RunOptions,
  stdout: NodeJS.WritableStream,
  _stderr: NodeJS.WritableStream,
): Promise<SelfEvolveRunResult> {
  // 1. Model is required (the hypothesis provider calls it).
  if (!options.model) {
    throw new CliError(
      "no model adapter configured (envoy self-evolve uses a model for the hypothesis; pass one via RunOptions.model)",
      EXIT_USAGE,
    );
  }

  // 2. Build paths. Each path has a sensible default under
  //    $ENVOY_HOME; for v0, we use `<cwd>/.envoymesh/...`.
  const cwd = options.cwd ?? process.cwd();
  const root = path.join(cwd, ".envoymesh");
  const paths: SelfEvolvePaths = {
    scoreboard: parsed.scoreboard ?? path.join(root, "verifier-scoreboard.yaml"),
    snapshotDir: parsed.snapshotDir ?? path.join(root, "snapshots"),
    benchmark: parsed.benchmark ?? path.join(root, "frozen-benchmark.yaml"),
    ruleset: parsed.ruleset ?? path.join(root, "verifier-rules.json"),
    agentsMd: parsed.agentsMd ?? path.join(root, "AGENTS.md"),
  };

  // 3. Wire the components.
  const hypothesisProvider = new ModelHypothesisProvider(options.model);
  const benchmarkRunner = new DefaultBenchmarkRunner();
  const currentRules: ReadonlyArray<VerifierRule> = DEFAULT_RULES;

  // 4. Run the cycle.
  const evolve = new SelfEvolve({
    paths,
    currentRules,
    hypothesisProvider,
    benchmarkRunner,
    shadowMode: !parsed.commit,
    ...(parsed.recentFailures !== undefined
      ? { recentFailureWindow: parsed.recentFailures }
      : {}),
  });
  const cycleResult = await evolve.runOneCycle();

  // 5. Print a human-readable summary.
  if (!parsed.quiet) {
    stdout.write(
      [
        `envoy self-evolve: cycle v${cycleResult.entry.version}`,
        `  status: ${cycleResult.entry.status}`,
        `  hypothesis: ${cycleResult.entry.hypothesis}`,
        `  pass rate: ${cycleResult.entry.passRateBefore.toFixed(2)} → ${cycleResult.entry.passRateAfter.toFixed(2)} (${cycleResult.entry.nRuns} runs)`,
        `  ruleset hash: ${cycleResult.entry.rulesetHash}`,
        cycleResult.kept && !parsed.commit
          ? `  (shadow mode: candidate was NOT committed)`
          : cycleResult.kept
            ? `  (committed to ${paths.ruleset})`
            : `  (reverted: no improvement)`,
        "",
      ].join("\n"),
    );
  }

  return {
    subcommand: "self-evolve",
    kept: cycleResult.kept,
    version: cycleResult.entry.version,
    hypothesis: cycleResult.entry.hypothesis,
    status: cycleResult.entry.status,
    passRateBefore: cycleResult.entry.passRateBefore,
    passRateAfter: cycleResult.entry.passRateAfter,
    nRuns: cycleResult.entry.nRuns,
    rulesetHash: cycleResult.entry.rulesetHash,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptyRunResult(): RunResult {
  return {
    subcommand: "run",
    content: "",
    stopReason: "end_turn",
    sessionId: "",
    iterations: 0,
    toolCalls: 0,
  };
}

async function resolvePrompt(
  parsed: Extract<ParsedArgs, { subcommand: "run" }>,
): Promise<string | null> {
  if (parsed.positional.length === 0) return null;
  const first = parsed.positional[0];
  if (first === undefined) return null;
  if (first === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  if (
    (first.startsWith("/") || first.startsWith("./") || first.startsWith("../")) &&
    await isFile(first)
  ) {
    return (await fs.readFile(first, "utf8")).trim();
  }
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
