/**
 * F17.1 — REPL types.
 *
 * The interactive REPL reads lines from a `LineReader`, dispatches
 * them to a long-lived `Agent`, and prints the result. A single
 * `Agent` is reused across turns (so the session, hooks, AGENTS.md,
 * and permission state are preserved).
 *
 * **Scope (F17.1):** the loop + agent reuse + exit on `/quit`,
 * `/exit`, or EOF. Slash command dispatch is F17.2; history
 * persistence is F17.3; tests are F17.4.
 *
 * **Design doc:** `docs/design.en.md` (Phase 6 F17).
 * **Implementation plan:** `docs/implementation-plan.md` §6.7.
 */

import type { HookRegistry } from "../../hooks/registry.js";
import type { ModelAdapter } from "../../model.js";
import type { RunParsedArgs } from "../argv.js";

/**
 * Async line source for the REPL. The default implementation wraps
 * `node:readline` on stdin; tests inject a fake that yields
 * predetermined lines so they can drive the loop deterministically.
 */
export interface LineReader extends AsyncIterable<string> {
  /**
   * Pull the next line. Returns `{ value, done: false }` on a
   * line, or `{ done: true }` on EOF / close.
   */
  next(): Promise<IteratorResult<string>>;
  /**
   * Close the underlying stream. Called from the REPL's `finally`
   * so we don't leak the readline interface on early exit.
   */
  close(): void;
}

/**
 * Options for `runRepl`. The host (CLI runner, programmatic caller)
 * provides the model + args; everything else is optional with a
 * sensible default.
 */
export interface ReplOptions {
  /** The model adapter. Required (same as `AgentOptions.model`). */
  model: ModelAdapter;
  /**
   * The parsed CLI args. Used to populate `AgentOptions`
   * (`sandbox`, `approval`, `maxTurns`, `maxCostUsd`, `cwd`,
   * `tracer`).
   */
  args: RunParsedArgs;
  /** Hook registry. Default: a fresh `HookRegistry()`. */
  hooks?: HookRegistry;
  /** Cwd. Default: `args.cwd ?? process.cwd()`. */
  cwd?: string;
  /** The prompt string. Default: `"envoy> "`. */
  prompt?: string;
  /** Stream to write the prompt + agent output to. Default: `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** Stream to write errors to (unknown commands, agent errors). Default: `process.stderr`. */
  stderr?: NodeJS.WritableStream;
  /**
   * Line reader. Default: a readline-based reader on stdin.
   * Tests inject a fake that yields predetermined lines.
   */
  lineReader?: LineReader;
}

/**
 * The result of a REPL session. Returned from `runRepl` so the
 * caller (the CLI runner) can build a `RunResult` for symmetry
 * with the single-shot path.
 */
export interface ReplResult {
  /** Always 0 for now (F17.1). Agent errors print to stderr but don't fail the REPL. */
  exitCode: number;
  /** Number of turns the agent ran (excludes blank + exit + unknown-slash lines). */
  turns: number;
  /** Total cost in USD across all turns. */
  totalCostUsd: number;
  /** The session id (shared across all turns). */
  sessionId: string;
}
