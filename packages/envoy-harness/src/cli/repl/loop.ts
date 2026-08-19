/**
 * F17.1 + F17.2 — REPL loop.
 *
 * The interactive REPL reads lines, dispatches them to a long-lived
 * `Agent`, and prints the result. A single `Agent` is reused across
 * turns so the session, hooks, AGENTS.md, and permission state are
 * preserved.
 *
 * **Scope:**
 * - F17.1: loop + agent reuse + exit on `/quit`, `/exit`, or EOF.
 * - F17.2: slash command registry (built-ins: `/help`, `/model`,
 *   `/provider`, `/sandbox`, `/approval`, `/clear`, `/cost`,
 *   `/status`, `/quit`; host-extensible via
 *   `ReplOptions.customCommands`).
 *
 * **Out of scope (later chunks):**
 * - History persistence (F17.3).
 * - Tab completion (deferred to F17.5 if needed).
 * - TUI rendering (out of scope for v0; plain readline + ANSI).
 *
 * **Design doc:** `docs/design.en.md` (Phase 6 F17).
 * **Implementation plan:** `docs/implementation-plan.md` §6.7.
 */

import * as readline from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import * as fs from "node:fs/promises";
import * as osModule from "node:os";
import * as pathModule from "node:path";
import {
  Agent,
  BUILTIN_TOOLS,
  HookRegistry,
  InMemorySession,
  JsonLinesTracer,
  NullTracer,
  newSessionId,
  ToolRegistry,
  type Session,
  type SessionMetadata,
} from "../../index.js";
import { BUILTIN_COMMANDS } from "./commands.js";
import { BUILTIN_INFO_COMMANDS } from "./commands-info.js";
import { EXIT_NAMES, ReplCommandRegistry, dispatchCommand, parseCommandLine } from "./registry.js";
import type { LineReader, ReplOptions, ReplResult } from "./types.js";

/**
 * Run the REPL. Returns when the user types `/quit`/`/exit` or
 * hits Ctrl-D. Errors from the agent loop print to stderr but
 * don't kill the REPL (the next turn can still run).
 *
 * **Why a separate `runRepl` (not inlined into `runAgent`)?**
 * the lifecycle is different: `runAgent` is one-shot (build → run
 * → print → exit), `runRepl` is long-lived (build once → loop).
 * Keeping them separate makes the dispatch in `run.ts` a clean
 * `if (args.repl) runRepl(...) else runAgent(...)`.
 */
export async function runRepl(opts: ReplOptions): Promise<ReplResult> {
  const out = opts.stdout ?? stdout;
  const err = opts.stderr ?? stderr;
  const prompt = opts.prompt ?? "envoy> ";
  const cwd = opts.cwd ?? opts.args.cwd ?? process.cwd();

  // 1. Build the line reader.
  const lineReader = opts.lineReader ?? createReadlineLineReader(prompt);

  // 2. Build the Agent ONCE. The session id is stable across turns.
  const session = newSession();
  const tools = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) tools.register(t);
  const hooks = opts.hooks ?? new HookRegistry();

  const agentOptions: ConstructorParameters<typeof Agent>[0] = {
    model: opts.model,
    tools,
    session,
    hooks,
    cwd,
  };
  if (opts.args.maxTurns !== undefined) {
    agentOptions.maxIterations = opts.args.maxTurns;
  }
  if (opts.args.maxCostUsd !== undefined) {
    agentOptions.maxCostUsd = opts.args.maxCostUsd;
  }
  if (opts.lspManager) {
    agentOptions.lspManager = opts.lspManager;
  }
  // F9.4: when --json is set, wire a JsonLinesTracer to stdout.
  // The trace events stream alongside the agent's final text;
  // downstream tools (jq, a viewer) parse the stream.
  if (opts.args.json) {
    agentOptions.tracer = new JsonLinesTracer(out);
  } else {
    agentOptions.tracer = new NullTracer();
  }

  const agent = new Agent(agentOptions);

  // 3. F17.2 + F17.2.5: build the command registry.
  //    Custom commands register FIRST; built-ins register
  //    LAST so they override on name collision. The plan
  //    says "Built-ins always win on name collision"; this
  //    order makes that contract true. BUILTIN_COMMANDS is
  //    the F17.2 set (9 commands); BUILTIN_INFO_COMMANDS
  //    is the F17.2.5 set (8 info commands).
  const registry = new ReplCommandRegistry();
  if (opts.customCommands) {
    registry.registerAll(opts.customCommands);
  }
  registry.registerAll(BUILTIN_COMMANDS);
  registry.registerAll(BUILTIN_INFO_COMMANDS);

  // 4. The loop.
  let turns = 0;
  let totalCostUsd = 0;
  // F17.3: `exiting` flag so the dispatcher's "exit" can
  // break out of the loop (rather than `return` from
  // `runRepl`). Returning would skip the `finally` block
  // that writes the history file.
  let exiting = false;

  // F17.3: history. We maintain our own array (the
  // readline interface's history is per-session and not
  // seedable from disk; persistence is our concern). The
  // history covers all non-blank lines the user types
  // (slash commands included — the user might want to
  // recall `/model foo` later). Blank lines are skipped.
  const historySize = opts.historySize ?? 1000;
  const history: string[] = [];
  const historyPath = resolveHistoryPath(opts.historyPath);
  if (historyPath) {
    const loaded = await loadHistory(historyPath, historySize);
    history.push(...loaded);
  }

  try {
    for await (const rawLine of lineReader) {
      // F17.3: if the previous iteration asked us to
      // exit, break here. We check at the TOP of each
      // iteration because `break` inside the switch
      // below only breaks the switch, not the for-await.
      if (exiting) break;
      const line = rawLine.trim();
      if (line === "") continue; // ignore blank lines

      // F17.3: append to history (dedupe consecutive,
      // like readline's default). Cap at historySize.
      // Skip exit commands (/quit, /exit) — they're noise
      // (the user almost never wants to recall them).
      if (!EXIT_NAMES.has(line)) {
        appendHistory(history, line, historySize);
      }

      // 4a. Slash commands.
      const parsed = parseCommandLine(line);
      if (parsed !== null) {
        const ctx = {
          agent,
          args: opts.args,
          stdout: out,
          stderr: err,
          turns,
          totalCostUsd,
          registry,
          ...(opts.scoreboard ? { scoreboard: opts.scoreboard } : {}),
          ...(opts.verifierRules ? { verifierRules: opts.verifierRules } : {}),
          ...(opts.profileLoader ? { profileLoader: opts.profileLoader } : {}),
        };
        const result = await dispatchCommand(registry, parsed.name, parsed.args, ctx);
        switch (result.kind) {
          case "ok":
            continue;
          case "exit":
            // Clean exit. Set the flag + continue so we
            // re-check `exiting` at the top of the loop
            // and break out (without falling through to
            // the non-slash block below).
            exiting = true;
            continue;
          case "unknown":
            err.write(
              `unknown command: ${result.name}\n` +
                `type /help for a list of commands\n`,
            );
            continue;
          case "error":
            err.write(`error: ${result.message}\n`);
            continue;
        }
      }

      // 4b. Non-slash input → send to the agent as a new turn.
      //     The session is shared, so each turn appends to
      //     the same transcript.
      try {
        const result = await agent.run(line);
        const text = result.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        if (!opts.args.quiet) {
          out.write(text + "\n");
        }
        turns++;
        totalCostUsd += result.metrics.costUsd;
      } catch (caught) {
        // Don't kill the REPL on a single turn's failure.
        // Print the error and let the user try again.
        err.write(`error: ${(caught as Error).message}\n`);
      }
    }
  } finally {
    lineReader.close();
    // F17.3: save history on exit. Errors here are silent
    // (the user is closing the REPL; we don't want a
    // history-write error to surface as a confusing
    // "error: ..." right at exit).
    if (historyPath) {
      await saveHistory(historyPath, history).catch(() => undefined);
    }
  }

  return { exitCode: 0, turns, totalCostUsd, sessionId: session.id };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a `LineReader` backed by `node:readline` on stdin. The
 * `for await` loop calls `rl.prompt()` between lines so the user
 * sees the prompt for each turn.
 *
 * **Why not `readline/promises`'s `rl.question()`?** the promise
 * API doesn't expose the readline stream's lifecycle cleanly; the
 * event-based iterator + `setPrompt` is the canonical pattern.
 */
function createReadlineLineReader(prompt: string): LineReader {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });
  rl.setPrompt(prompt);
  rl.prompt();

  const reader: LineReader = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return this;
    },
    async next(): Promise<IteratorResult<string>> {
      // Use a once-style wrapper around the 'line' / 'close' events.
      // Each `next()` call waits for exactly one line.
      return new Promise((resolve) => {
        const onLine = (line: string) => {
          cleanup();
          // Re-show the prompt for the next readline.
          rl.prompt();
          resolve({ value: line, done: false });
        };
        const onClose = () => {
          cleanup();
          resolve({ value: undefined as unknown as string, done: true });
        };
        const cleanup = () => {
          rl.removeListener("line", onLine);
          rl.removeListener("close", onClose);
        };
        rl.once("line", onLine);
        rl.once("close", onClose);
      });
    },
    close() {
      rl.close();
    },
  };
  return reader;
}

/**
 * Build a fresh `Session` for the REPL. The session id is what
 * gets returned in `ReplResult.sessionId` so the caller can
 * correlate.
 */
function newSession(): Session {
  const meta: SessionMetadata = {
    cwd: process.cwd(),
    permissionMode: "workspace-write",
    startedAt: new Date().toISOString(),
    title: "repl",
  };
  return new InMemorySession(newSessionId(), meta);
}

// ---------------------------------------------------------------------------
// F17.3: history persistence
// ---------------------------------------------------------------------------

/** The default XDG state home path for envoy-harness. */
function defaultHistoryPath(): string {
  const env = process.env["ENVOY_HARNESS_HISTORY"];
  if (env && env.length > 0) return env;
  const xdgState = process.env["XDG_STATE_HOME"];
  const home = xdgState && xdgState.length > 0 ? xdgState : `${osHomedir()}/.local/state`;
  return `${home}/envoy-harness/history`;
}

/** Lazy `os.homedir()` — kept as a function so tests can stub. */
function osHomedir(): string {
  // `os` is imported at the top; we just route through a
  // helper to keep the path-resolution code in one place.
  return osModule.homedir();
}

/**
 * Resolve the history path. Returns `null` when history
 * persistence is disabled (`historyPath: ""` in
 * `ReplOptions`).
 */
function resolveHistoryPath(option: string | undefined): string | null {
  if (option === "") return null; // explicitly disabled
  if (option !== undefined) return option;
  return defaultHistoryPath();
}

/**
 * Load the history file. Returns the lines (most recent
 * `maxLines` lines; older lines are dropped on load).
 *
 * **Returns `[]` when the file doesn't exist** (first run).
 * **Returns `[]` on read error** (don't block the REPL on
 * a corrupt history file).
 */
async function loadHistory(path: string, maxLines: number): Promise<string[]> {
  try {
    const content = await fs.readFile(path, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    // Keep the most recent maxLines lines.
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * Save the history file. Writes the lines (one per row,
 * trailing newline). Overwrites the file. Creates the
 * parent directory if it doesn't exist.
 *
 * **Silent on error** (the user is closing the REPL; a
 * write failure is not actionable here).
 */
async function saveHistory(path: string, history: ReadonlyArray<string>): Promise<void> {
  // mkdir-p the parent so a fresh-install write doesn't
  // fail with ENOENT.
  await fs.mkdir(pathModule.dirname(path), { recursive: true });
  await fs.writeFile(path, history.join("\n") + "\n", "utf-8");
}

/**
 * Append a line to the history. Dedupes consecutive
 * duplicates (matches readline's default behavior) and
 * caps at `maxLines` (FIFO).
 */
function appendHistory(
  history: string[],
  line: string,
  maxLines: number,
): void {
  // Skip blank lines (already filtered by the loop, but
  // defensive).
  if (line === "") return;
  // Dedupe consecutive.
  const last = history[history.length - 1];
  if (last === line) return;
  history.push(line);
  // Cap (FIFO).
  while (history.length > maxLines) {
    history.shift();
  }
}
