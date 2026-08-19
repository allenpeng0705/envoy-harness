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
import * as os from "node:os";
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
  loadRulesetFromFile,
  ModelHypothesisProvider,
  NullTracer,
  VerboseTracer,
  newSessionId,
  SelfEvolve,
  SessionStore,
  Team,
  ToolRegistry,
  VERSION,
  DEFAULT_RULES,
  createProviderAdapter,
  parseTeamToml,
  type AskHandler,
  type ModelAdapter,
  type Session,
  type SelfEvolvePaths,
  type SessionMetadata,
  type TeamConfig,
  type VerifierRule,
} from "../index.js";
import { formatHelp, parseArgs, type ParsedArgs } from "./argv.js";
import { runRepl } from "./repl/index.js";

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
  /**
   * F14.2: when `args.repl` is set, the runner
   * uses this line reader instead of opening
   * readline on stdin. Tests inject a fake that
   * yields predetermined lines (so the test
   * doesn't hang on stdin). The bin script leaves
   * this undefined (the default readline reader
   * opens stdin).
   */
  lineReader?: import("./repl/index.js").LineReader;
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

/** Result of a successful `team` invocation. */
export interface TeamRunResult {
  /** Discriminator for the union. */
  subcommand: "team";
  /** The team's name. */
  teamName: string;
  /** Per-agent results, in execution order. */
  agents: ReadonlyArray<{
    id: string;
    finalText: string;
    stopReason: string;
    durationMs: number;
  }>;
  /** "completed" if all agents finished cleanly. */
  status: "completed" | "failed";
  /** Error message if `status === "failed"`. */
  error?: string;
}

/** Union of the subcommand results. */
export type CliRunResult = RunResult | SelfEvolveRunResult | TeamRunResult;

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
  if (parsed.subcommand === "team") {
    return runTeam(parsed, options, stdout, stderr);
  }
  // 3a. F17.1: --repl activates the interactive REPL. The
  //     REPL takes no positional prompt; a positional + --repl
  //     is a usage error.
  if (parsed.repl) {
    if (parsed.positional.length > 0) {
      throw new CliError(
        "--repl takes no positional prompt; type into the REPL instead",
        EXIT_USAGE,
      );
    }
    return runReplDispatch(parsed, options, stdout, stderr);
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
  // F-fix: `--plan` forces a read-only session (plan mode is
  // read + think, no writes) regardless of `--sandbox`.
  const effectiveMode: SessionMetadata["permissionMode"] = parsed.plan
    ? "read-only"
    : parsed.sandbox ?? "read-only";
  const meta: SessionMetadata = {
    cwd,
    ...(effectiveMode !== undefined ? { permissionMode: effectiveMode } : {}),
    startedAt: new Date().toISOString(),
    title: prompt.slice(0, 60),
  };
  // For SessionMetadata, `permissionMode` is optional but
  // not nullable under exactOptionalPropertyTypes. When we
  // spread `meta` later (e.g. in the --fork path), we
  // need a clean copy without the optional `undefined`.
  // This helper gives us that.
  // (no helper needed — see resolveSession below)

  // F14.1: resolve the session. Three modes:
  //   1. `--resume <id>`  → load from disk, pass to Agent.
  //   2. `--fork <id>`    → load from disk, copy messages to
  //                         a NEW session (fresh id), persist.
  //   3. `--persist`      → create a new persisted session.
  //   4. (none of the above) → in-memory session (current behavior).
  const session: Session = await resolveSession(parsed, meta, stderr);

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
  } else {
    // F-fix: the CLI help promises a default $5.00 ceiling;
    // apply it (the library's Agent itself stays uncapped).
    agentOptions.maxCostUsd = DEFAULT_MAX_COST_USD;
  }
  if (parsed.approval !== undefined) {
    agentOptions.approval = parsed.approval as
      | "unless-trusted"
      | "on-request"
      | "granular"
      | "never";
  }
  if (parsed.plan) {
    agentOptions.systemPrompt =
      "You are in PLAN MODE. Investigate and produce a plan only — " +
      "do not make any changes to the workspace. Your session is read-only.";
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
  } else if (parsed.verbose) {
    // F-fix: `--verbose` prints human-readable tool-call lines
    // to stderr (JSON Lines takes precedence when both are set).
    agentOptions.tracer = new VerboseTracer(stderr);
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

/** F-fix: default cost ceiling for the CLI (design §19: 5.00). */
export const DEFAULT_MAX_COST_USD = 5.0;

// ---------------------------------------------------------------------------
// F17.1: --repl dispatch
// ---------------------------------------------------------------------------

/**
 * Run the REPL and convert the result to a `RunResult` for
 * symmetry with the one-shot path. The `content` field is empty
 * (the REPL already streamed output to stdout); the `iterations`
 * is the REPL's turn count; the `sessionId` is the shared session.
 *
 * **F14.2 persistence wiring:**
 * - `--session-dir <path>` + `--resume <id>`: load the
 *   persisted session and pass `sessionStore +
 *   resumeFromId` to the loop.
 * - `--session-dir <path>` + `--persist` (no `--resume`):
 *   create a new persisted session and pass
 *   `createSession` (a factory that the loop awaits).
 * - Otherwise: the default in-memory session
 *   (no `sessionStore` / `resumeFromId` / `createSession`).
 *
 * `CliError(EXIT_USAGE)` surfaces the "missing
 * session" / "bad file" cases (so the bin script's
 * exit code is 64, not 1). All other errors
 * propagate as `Error` (a programming bug).
 */
async function runReplDispatch(
  parsed: Extract<ParsedArgs, { subcommand: "run" }>,
  options: RunOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<RunResult> {
  // Resolve the model the same way `runAgent` does: use the
  // injected model if provided, else dispatch via --provider +
  // env vars.
  const model = resolveModel(parsed, options);

  // F14.2: build the persistence options. Three modes
  // (see also the same block in `runAgent` / `resolveSession`):
  //   1. --resume <id>  → load the persisted session.
  //   2. --persist      → create a new persisted session.
  //   3. neither        → default in-memory.
  // `--resume` + `--fork` are mutually exclusive (F14.1
  // enforces this in `resolveSession` for the one-shot
  // path; we don't accept `--fork` in REPL mode at
  // all — it's a one-shot concept).
  if (parsed.resume && parsed.persist) {
    throw new CliError(
      "--resume and --persist are mutually exclusive in --repl mode (pick one)",
      EXIT_USAGE,
    );
  }

  // We collect the persistence options for the
  // `runRepl` call below. We need a SessionStore
  // for both --resume and --persist; the Session
  // instance itself is built lazily (either by
  // `sessionStore.load(id)` for --resume, or by
  // the `createSession` factory for --persist).
  let sessionStore: import("../index.js").SessionStore | undefined;
  let resumeFromId: string | undefined;
  let createSession: (() => Promise<import("../index.js").Session>) | undefined;
  if (parsed.resume || parsed.persist) {
    sessionStore = new SessionStore({ dir: defaultSessionDir(parsed) });
    if (parsed.resume) {
      // Validate the session exists up front (the
      // loop would also throw on `sessionStore.load`,
      // but doing it here gives us a clean
      // `CliError(EXIT_USAGE)` for the bin script).
      if (!(await sessionStore.exists(parsed.resume))) {
        throw new CliError(
          `--resume: session not found: ${parsed.resume}`,
          EXIT_USAGE,
        );
      }
      resumeFromId = parsed.resume;
      stderr.write(`resumed session: ${parsed.resume}\n`);
    } else {
      // --persist: create a new persisted session.
      // We build a `SessionMetadata` from the parsed
      // args (cwd + sandbox). The loop awaits the
      // factory; the file is created on first call.
      const meta: SessionMetadata = {
        cwd: parsed.cwd ?? options.cwd ?? process.cwd(),
        permissionMode: parsed.sandbox ?? "read-only",
        startedAt: new Date().toISOString(),
        title: "repl",
      };
      const store = sessionStore;
      createSession = async () => {
        const s = await store.create(meta);
        // Print the new session id to stderr so the
        // user can --resume it later.
        stderr.write(`persisted session: ${s.id}\n`);
        return s;
      };
    }
  }

  const replResult = await runRepl({
    model,
    args: parsed,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.lineReader ? { lineReader: options.lineReader } : {}),
    ...(sessionStore ? { sessionStore } : {}),
    ...(resumeFromId ? { resumeFromId } : {}),
    ...(createSession ? { createSession } : {}),
    stdout,
    stderr,
  });

  return {
    subcommand: "run",
    content: "",
    stopReason: "end_turn",
    sessionId: replResult.sessionId,
    iterations: replResult.turns,
    toolCalls: 0,
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
  // F-fix: build on the committed ruleset when one exists
  // (the protocol is now real: candidates select rule names,
  // and the committed file is re-loadable). Fresh installs
  // fall back to DEFAULT_RULES.
  const committed = await loadRulesetFromFile(paths.ruleset, DEFAULT_RULES);
  const currentRules: ReadonlyArray<VerifierRule> = committed ?? DEFAULT_RULES;

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
// team subcommand (F9.3)
// ---------------------------------------------------------------------------

async function runTeam(
  parsed: Extract<ParsedArgs, { subcommand: "team" }>,
  options: RunOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<TeamRunResult> {
  void stderr;
  // 1. Resolve the model. Same dispatch as the `run`
  //    subcommand: programmatic injection takes
  //    precedence; else --provider + env.
  const model = resolveModelForTeam(parsed, options);

  // 2. Read the TOML config (positional[0]).
  if (parsed.positional.length === 0) {
    throw new CliError(
      "team subcommand requires a TOML config path (e.g. `envoy team team.toml`)",
      EXIT_USAGE,
    );
  }
  const configPath = parsed.positional[0]!;
  let config: TeamConfig;
  try {
    const toml = await fs.readFile(configPath, "utf8");
    config = parseTeamToml(toml);
  } catch (err) {
    // Check by name (not instanceof) so the bundled
    // dist's class identity matches. instanceof can
    // fail when the same class is loaded from a
    // different module instance.
    if ((err as Error).name === "TomlParseError") {
      throw new CliError(
        `invalid team config at ${configPath}: ${(err as Error).message}`,
        EXIT_DATAERR,
      );
    }
    throw new CliError(
      `failed to read team config at ${configPath}: ${(err as Error).message}`,
      EXIT_DATAERR,
    );
  }

  // 3. Build the team and run.
  const team = new Team({
    config,
    model,
    cwd: parsed.cwd ?? options.cwd ?? process.cwd(),
    input: parsed.input ?? "",
  });
  const result = await team.runOnce();

  // 4. Print the summary.
  if (!parsed.quiet) {
    const lines = [
      `envoy team: ${result.teamName}`,
      `  status: ${result.status}`,
    ];
    for (const a of result.agents) {
      lines.push(`  [${a.id}] (${a.durationMs}ms): ${a.finalText.split("\n")[0]?.slice(0, 100) ?? ""}`);
    }
    if (result.error) lines.push(`  error: ${result.error}`);
    lines.push("");
    stdout.write(lines.join("\n"));
  }

  return {
    subcommand: "team",
    teamName: result.teamName,
    agents: result.agents,
    status: result.status,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

function resolveModelForTeam(
  parsed: Extract<ParsedArgs, { subcommand: "team" }>,
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

/**
 * Resolve the default session directory.
 *
 * Order:
 * 1. `--session-dir <path>` (if set)
 * 2. `$ENVOY_HARNESS_SESSION_DIR` (if set)
 * 3. `~/.local/state/envoy-harness/sessions`
 */
function defaultSessionDir(parsed: Extract<ParsedArgs, { subcommand: "run" }>): string {
  if (parsed.sessionDir) return parsed.sessionDir;
  const env = process.env["ENVOY_HARNESS_SESSION_DIR"];
  if (env && env.length > 0) return env;
  return `${process.env["HOME"] ?? os.homedir()}/.local/state/envoy-harness/sessions`;
}

/**
 * F14.1: resolve the session for the `run` subcommand.
 *
 * Four modes:
 * 1. `--resume <id>`  → load from disk, pass to Agent.
 * 2. `--fork <id>`    → load from disk, copy messages to
 *                       a NEW session (fresh id), persist.
 * 3. `--persist`      → create a new persisted session.
 * 4. (none of the above) → in-memory session (current behavior).
 *
 * **Mutual exclusion:** `--resume` and `--fork` are
 * mutually exclusive (you can resume a session OR
 * fork a session, not both). The argv parser doesn't
 * enforce this; we do it here.
 */
async function resolveSession(
  parsed: Extract<ParsedArgs, { subcommand: "run" }>,
  meta: SessionMetadata,
  stderr: NodeJS.WritableStream,
): Promise<Session> {
  // --resume and --fork are mutually exclusive.
  if (parsed.resume && parsed.fork) {
    throw new CliError(
      "--resume and --fork are mutually exclusive (pick one)",
      EXIT_USAGE,
    );
  }

  // Default: in-memory session.
  if (!parsed.resume && !parsed.fork && !parsed.persist) {
    return new InMemorySession(newSessionId(), meta);
  }

  // --resume, --fork, --persist all need a SessionStore.
  const store = new SessionStore({ dir: defaultSessionDir(parsed) });

  // --resume: load and return.
  if (parsed.resume) {
    try {
      const session = await store.load(parsed.resume);
      // The session's cwd + permissionMode come from when
      // it was created. We don't override (the user might
      // have changed cwd since then; that's their call).
      return session;
    } catch (err) {
      throw new CliError(
        `failed to load session ${parsed.resume}: ${(err as Error).message}`,
        EXIT_USAGE,
      );
    }
  }

  // --fork: load the source, copy messages to a new session.
  if (parsed.fork) {
    let source;
    try {
      source = await store.load(parsed.fork);
    } catch (err) {
      throw new CliError(
        `failed to load session ${parsed.fork} for fork: ${(err as Error).message}`,
        EXIT_USAGE,
      );
    }
    // Create a new persisted session with a fresh id.
    // Inherit the source's title if set, else use the new
    // session's title (the user can /rename later).
    const newMeta: SessionMetadata = {
      cwd: meta.cwd,
      ...(meta.permissionMode !== undefined
        ? { permissionMode: meta.permissionMode }
        : {}),
      startedAt: meta.startedAt,
      title: source.metadata.title ?? meta.title ?? "forked session",
    };
    const forked = await store.createWithId(newSessionId(), newMeta);
    // Copy the source's messages.
    for (const m of source.messages) {
      forked.appendMessage(m.role, m.content);
    }
    stderr.write(
      `forked session ${parsed.fork} -> new session ${forked.id}\n`,
    );
    return forked;
  }

  // --persist: create a new persisted session.
  const session = await store.create(meta);
  stderr.write(`persisted session: ${session.id}\n`);
  return session;
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
