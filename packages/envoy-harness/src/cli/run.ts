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
  FederatedScoreboard,
  HookRegistry,
  InMemorySession,
  JsonLinesTracer,
  LocalPeerSource,
  ModelHypothesisProvider,
  NullTracer,
  newSessionId,
  SelfEvolve,
  ToolRegistry,
  VERSION,
  DEFAULT_RULES,
  createProviderAdapter,
  type AskHandler,
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
  /** F9.1: per-call approval handler. When the agent loop
   *  hits a hook decision of `kind: "ask"`, this handler is
   *  called. The default (when undefined) is a built-in
   *  fallback that writes a one-line "ask" record to stderr
   *  and returns `deny` (safe in headless contexts). */
  askHandler?: AskHandler;
  /**
   * F9.4: tracer. When set, the agent emits trace
   * events to this tracer instead of the default
   * NullTracer. The CLI's `--json` flag wires a
   * `JsonLinesTracer` to stdout automatically;
   * programmatic callers can inject a custom
   * tracer (e.g. one that ships to a logging
   * service).
   */
  tracer?: import("../index.js").Tracer;
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
  /** Federated pull + adopt results (only present when --pull is set). */
  federated?: {
    /** Whether the pull was skipped (optIn: false). */
    skipped: boolean;
    /** Number of candidates that passed the local gate. */
    adopted: number;
    /** Number of candidates that failed the local gate. */
    rejected: number;
    /** Number of candidates filtered out before the gate. */
    filtered: number;
  };
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

  // 2. Resolve the model. F7.5: when no model is injected
  //    via RunOptions, dispatch from --provider + env vars.
  //    This makes the bin script usable end-to-end (no
  //    need to wire a default adapter in user code).
  const model = resolveModel(parsed, options);

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
    model,
    tools,
    session,
    hooks,
    cwd,
  };
  if (parsed.maxTurns !== undefined) {
    agentOptions.maxIterations = parsed.maxTurns;
  }
  if (parsed.maxCostUsd !== undefined) {
    agentOptions.maxCostUsd = parsed.maxCostUsd;
  }
  if (options.askHandler) {
    agentOptions.askHandler = options.askHandler;
  } else {
    // F9.1 default: log to stderr + deny. The host (Tauri,
    // web, etc.) injects a real UI handler via RunOptions.
    agentOptions.askHandler = defaultAskHandler;
  }
  // F9.4: when --json is set, wire a JsonLinesTracer
  // to stdout. The trace events stream alongside the
  // final text; downstream tools (jq, a viewer) parse
  // the stream.
  if (parsed.json) {
    agentOptions.tracer = new JsonLinesTracer(stdout);
  } else if (options.tracer) {
    // Programmatic injection takes precedence (the host
    // might want a different sink — file, websocket, etc.).
    agentOptions.tracer = options.tracer;
  } else {
    // Default: NullTracer (no observable side effect).
    agentOptions.tracer = new NullTracer();
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
  // 1. Resolve the model. F7.5: dispatch via --provider + env
  //    when no model is injected via RunOptions. Same helper
  //    as `runAgent` (the hypothesis provider just needs a
  //    ModelAdapter; the wire format is provider-specific).
  const model = options.model
    ? options.model
    : (() => {
        if (!parsed.provider) {
          throw new CliError(
            "no model configured: pass one via RunOptions.model, or use --provider <openai|anthropic|deepseek|ollama> with the matching *_API_KEY env var",
            EXIT_USAGE,
          );
        }
        try {
          return createProviderAdapter({
            provider: parsed.provider,
            ...(parsed.model !== undefined ? { model: parsed.model } : {}),
          });
        } catch (err) {
          throw new CliError((err as Error).message, EXIT_USAGE);
        }
      })();

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
  const adoptionsFile = parsed.adoptions ?? path.join(root, "federated-adoptions.yaml");

  // 3. Wire the components.
  const hypothesisProvider = new ModelHypothesisProvider(model);
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

  // 5. Federated pull (if --pull). v0: LocalPeerSource returns
  //    []. The pull runs the local 5-step gate against any
  //    candidates and records the audit trail. Without --pull,
  //    the federated layer is a no-op.
  let federated: SelfEvolveRunResult["federated"];
  if (parsed.pull) {
    const fed = new FederatedScoreboard(new LocalPeerSource());
    const pullResult = await fed.pull({ optIn: true });
    if (!pullResult.skipped) {
      const adoptResult = await fed.adopt(pullResult, evolve, {
        adoptionsFile,
        ...(parsed.peerId !== undefined ? { peerId: parsed.peerId } : {}),
      });
      federated = {
        skipped: false,
        adopted: adoptResult.adopted.length,
        rejected: adoptResult.rejected.length,
        filtered: pullResult.rejected.length,
      };
    } else {
      federated = { skipped: true, adopted: 0, rejected: 0, filtered: 0 };
    }
  }

  // 6. Print a human-readable summary.
  if (!parsed.quiet) {
    const lines = [
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
    ];
    if (federated) {
      if (federated.skipped) {
        lines.push(`  federated: skipped (no --pull peers)`);
      } else {
        lines.push(
          `  federated: ${federated.adopted} adopted, ${federated.rejected} rejected, ${federated.filtered} filtered`,
        );
        lines.push(`    (audit log: ${adoptionsFile})`);
      }
    }
    lines.push("");
    stdout.write(lines.join("\n"));
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
    ...(federated !== undefined ? { federated } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the model adapter for the `run` subcommand. F7.5:
 *
 * - If `RunOptions.model` is provided, use it (programmatic
 *   injection takes precedence over the CLI).
 * - Else if `--provider <name>` is given, dispatch via
 *   `createProviderAdapter`, reading the matching env var.
 * - Else throw `CliError(EXIT_USAGE)` with a message that
 *   tells the user how to fix it.
 *
 * `createProviderAdapter` throws on unknown provider /
 * missing env var; we wrap as `CliError` so the bin
 * script's exit code is correct (USAGE, not ERROR).
 */
function resolveModel(
  parsed: Extract<ParsedArgs, { subcommand: "run" }>,
  options: RunOptions,
): ModelAdapter {
  if (options.model) return options.model;
  if (!parsed.provider) {
    throw new CliError(
      "no model configured: pass one via RunOptions.model, or use --provider <openai|anthropic|deepseek|ollama> with the matching *_API_KEY env var",
      EXIT_USAGE,
    );
  }
  try {
    return createProviderAdapter({
      provider: parsed.provider,
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    });
  } catch (err) {
    throw new CliError((err as Error).message, EXIT_USAGE);
  }
}



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

// ---------------------------------------------------------------------------
// F9.1: default ask handler (CLI fallback)
// ---------------------------------------------------------------------------

/**
 * F9.1 default `askHandler` for the CLI runner. When the
 * agent loop hits a hook decision of `kind: "ask"`, the
 * runner writes a one-line "ask" record to stderr
 * (so the user can see what was asked) and returns
 * `deny` (safe default — the tool is blocked).
 *
 * **Why deny, not allow:** the bin script is the
 * headless context. There's no UI to show a prompt;
 * the user can't see it. Allowing would silently
 * grant the model any action that the hook flagged.
 * Denying ensures the user notices (the transcript
 * shows "denied by user: no ask handler configured").
 *
 * **Production hosts** (Tauri, web, etc.) inject a
 * real UI handler via `RunOptions.askHandler`. The
 * production handler returns whatever the user
 * picked. This default is for the v0 CLI.
 */
export const defaultAskHandler: AskHandler = async (req) => {
  process.stderr.write(
    `envoy-harness: ask: ${req.tool}(${JSON.stringify(req.args)}) — denied (no UI handler in v0 CLI)\n`,
  );
  return { kind: "deny", reason: "no UI ask handler configured (CLI v0)" };
};
