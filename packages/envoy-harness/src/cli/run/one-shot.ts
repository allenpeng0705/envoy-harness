/**
 * The `run` subcommand (default; one-shot) handler.
 * Extracted in T3.2 from `cli/run.ts` so each
 * subcommand has its own file.
 *
 * The flow:
 * 1. Resolve the prompt (positional, `-` for
 *    stdin, or a path).
 * 2. Resolve the model (programmatic or
 *    `--provider + env`).
 * 3. Load the user config (TOML; CLI > config
 *    > default per design §20.1).
 * 4. Build the agent (sandbox policy from CLI
 *    + plan + config; tools; hooks; tracer;
 *    ask handler).
 * 5. Run the loop.
 * 6. Flush the session (so the JSONL write chain
 *    drains before the CLI returns).
 * 7. Print the result.
 */
import {
  Agent,
  BUILTIN_TOOLS,
  ConfigLoadError,
  EXIT_USAGE,
  HookRegistry,
  JsonLinesTracer,
  loadConfig,
  NullTracer,
  ToolRegistry,
  VerboseTracer,
  type ConfigLayer,
  type Session,
  type SessionMetadata,
} from "../../index.js";
import { resolveSession } from "../../session/resolve.js";
import type { ParsedArgs } from "../argv.js";
import { CliError } from "./errors.js";
import {
  DEFAULT_MAX_COST_USD,
  defaultAskHandler,
  defaultSessionDir,
  resolveModel,
  resolvePrompt,
} from "./helpers.js";
import type { RunOptions, RunResult } from "./types.js";

export async function runAgent(
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

  // 2.5. T2.2: load the user config (TOML). CLI flags
  //      win over the file; the file wins over the agent's
  //      built-in defaults (design §20.1 layer composition).
  //      Missing file → empty config (silent). Malformed file
  //      → throws ConfigLoadError (caught below as a usage error).
  let configLayer: ConfigLayer = {};
  const hasExplicitPath =
    parsed.config !== undefined ||
    process.env["ENVOY_HARNESS_CONFIG"] !== undefined;
  if (hasExplicitPath) {
    // User explicitly asked for a file (--config or env var) —
    // surface errors. The loader resolves the env var path
    // when filePath is undefined.
    const { layer } = await loadConfig(
      parsed.config !== undefined ? { filePath: parsed.config } : {},
    );
    configLayer = layer;
  } else {
    // Default path: try, but silence ENOENT (most users don't
    // have a config file yet). Malformed files still throw.
    try {
      const { layer } = await loadConfig();
      configLayer = layer;
    } catch (err) {
      if (
        !(err instanceof ConfigLoadError) ||
        !/ENOENT/.test(String(err.cause))
      ) {
        throw err;
      }
    }
  }

  // 3. Build the agent.
  let cwd = parsed.cwd ?? options.cwd ?? process.cwd();
  // F-fix: `--plan` forces a read-only session (plan mode is
  // read + think, no writes) regardless of `--sandbox`.
  // T2.2: the config file's `permissionMode` is the next
  // fallback (CLI > config > "read-only" default).
  const configMode = configLayer.permissionMode;
  const effectiveMode: SessionMetadata["permissionMode"] = parsed.plan
    ? "read-only"
    : parsed.sandbox ?? configMode ?? "read-only";
  const meta: SessionMetadata = {
    cwd,
    ...(effectiveMode !== undefined ? { permissionMode: effectiveMode } : {}),
    startedAt: new Date().toISOString(),
    title: prompt.slice(0, 60),
  };

  // F14.1: resolve the session. Three modes:
  //   1. `--resume <id>`  → load from disk, pass to Agent.
  //   2. `--fork <id>`    → load from disk, copy messages to
  //                         a NEW session (fresh id), persist.
  //   3. `--persist`      → create a new persisted session.
  //   4. (none of the above) → in-memory session (current behavior).
  const session: Session = await resolveSession(
    parsed,
    meta,
    defaultSessionDir(parsed),
    stderr,
  );
  // F-fix: the session's recorded cwd wins (matches the REPL's
  // `--repl --resume` behavior). For fresh in-memory / --persist
  // sessions this is the same cwd we just built; for --resume it
  // restores the directory the session was created in.
  cwd = session.metadata.cwd;

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

  // F-fix: make sure the transcript is durable before the CLI
  // returns (PersistedSession's appends are fire-and-forget).
  await session.flush();

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
