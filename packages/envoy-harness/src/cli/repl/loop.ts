/**
 * F17.1 — REPL loop.
 *
 * The interactive REPL reads lines, dispatches them to a long-lived
 * `Agent`, and prints the result. A single `Agent` is reused across
 * turns so the session, hooks, AGENTS.md, and permission state are
 * preserved.
 *
 * **Scope (F17.1):**
 * - `--repl` activates the REPL; no positional prompt required.
 * - Readline-based prompt (`envoy> `).
 * - Single `Agent` constructed once and reused across turns.
 * - Non-slash input → `agent.run(input)` as a new turn.
 * - Exit on `/quit`, `/exit`, or EOF (Ctrl-D).
 * - Empty lines are ignored (don't reach the model).
 * - Unknown `/command` lines print to stderr (F17.2 will replace
 *   with a real registry).
 *
 * **Out of scope (later chunks):**
 * - Slash command registry (F17.2).
 * - History persistence (F17.3).
 * - Tab completion (deferred to F17.5 if needed).
 *
 * **Design doc:** `docs/design.en.md` (Phase 6 F17).
 * **Implementation plan:** `docs/implementation-plan.md` §6.7.
 */

import * as readline from "node:readline";
import { stdin, stdout, stderr } from "node:process";
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
import type { LineReader, ReplOptions, ReplResult } from "./types.js";

/**
 * Built-in exit commands. F17.1 only knows these; F17.2 will
 * replace the hard-coded set with a real registry.
 */
const EXIT_COMMANDS = new Set(["/quit", "/exit"]);

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
  // F9.4: when --json is set, wire a JsonLinesTracer to stdout.
  // The trace events stream alongside the agent's final text;
  // downstream tools (jq, a viewer) parse the stream.
  if (opts.args.json) {
    agentOptions.tracer = new JsonLinesTracer(out);
  } else {
    agentOptions.tracer = new NullTracer();
  }

  const agent = new Agent(agentOptions);

  // 3. The loop.
  let turns = 0;
  let totalCostUsd = 0;
  try {
    for await (const rawLine of lineReader) {
      const line = rawLine.trim();
      if (line === "") continue; // ignore blank lines

      if (EXIT_COMMANDS.has(line)) {
        // Clean exit.
        break;
      }

      if (line.startsWith("/")) {
        // F17.2 will replace this with the slash command registry.
        // For F17.1, surface unknown commands and continue.
        err.write(`unknown command: ${line} (F17.2 will add the registry)\n`);
        continue;
      }

      // Send to the agent as a new turn. The session is shared,
      // so each turn appends to the same transcript.
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
