/**
 * F17.1 + F17.2 — REPL types.
 *
 * The interactive REPL reads lines from a `LineReader`, dispatches
 * them to a long-lived `Agent`, and prints the result. A single
 * `Agent` is reused across turns (so the session, hooks, AGENTS.md,
 * and permission state are preserved).
 *
 * **Scope:**
 * - F17.1: the loop + agent reuse + exit on `/quit`, `/exit`, or EOF.
 * - F17.2: slash command registry (`/help`, `/model`, `/provider`,
 *   `/sandbox`, `/approval`, `/clear`, `/cost`, `/status`,
 *   `/quit` + aliases).
 * - F17.3: history persistence (deferred).
 *
 * **Design doc:** `docs/design.en.md` (Phase 6 F17).
 * **Implementation plan:** `docs/implementation-plan.md` §6.7.
 */

import type { HookRegistry } from "../../hooks/registry.js";
import type { ModelAdapter } from "../../model.js";
import type { Agent } from "../../agent.js";
import type { VerifierRule } from "../../verifier/types.js";
import type { RunParsedArgs } from "../argv.js";
import type { ReplCommandRegistry } from "./registry.js";

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
  /**
   * F17.2: host-registered slash commands. Built-ins always
   * win on name collision. Use this to extend the REPL with
   * project-specific commands (e.g. `/pr`, `/deploy`).
   */
  customCommands?: ReadonlyArray<ReplCommand>;
  /**
   * F17.2.5: optional scoreboard (F6). The `/scoreboard`
   * command reads this; when undefined, the command prints
   * "no scoreboard loaded".
   */
  scoreboard?: { entries?: () => ReadonlyArray<unknown> };
  /**
   * F17.2.5: optional verifier rules. The `/rules` command
   * reads this; when undefined, falls back to DEFAULT_RULES.
   * Shape matches the public `VerifierRule` type from
   * `src/verifier/types.ts`.
   */
  verifierRules?: ReadonlyArray<VerifierRule>;
  /**
   * F17.2.5: optional profile loader. The `/profile` command
   * reads this; when undefined, prints "no profile loader".
   * The host reads the TOML config and adapts it to the
   * `ReplProfileLoader` shape.
   */
  profileLoader?: ReplProfileLoader;
  /**
   * F17.2.5: optional LSP manager. When set, the 4 LSP
   * tools are auto-registered (F9.2) and the `/lsp`
   * command lists the active servers. When undefined,
   * the LSP tools are not registered and `/lsp` prints
   * "no LSP servers configured".
   */
  lspManager?: import("../../lsp/index.js").LspManager;
  /**
   * F17.3: path to the history file. On REPL start, the
   * file is read (if it exists) and the lines become the
   * initial history. On REPL exit, the accumulated history
   * is written back to the file.
   *
   * **Default:** `~/.local/state/envoy-harness/history`
   * (or `$ENVOY_HARNESS_HISTORY` if set). Override via
   * this option for tests (a temp file) or for hosts
   * that want a different location.
   *
   * **Disable:** set this to `""` (empty string) to
   * skip history persistence entirely. Useful for
   * non-interactive use cases (CI, scripted runs).
   */
  historyPath?: string;
  /**
   * F17.3: max number of history lines to keep. When the
   * history exceeds this size, the oldest lines are
   * dropped (FIFO). Default: 1000.
   */
  historySize?: number;
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

/**
 * F17.2.5: a profile loaded from the TOML config. The keys
 * are open-ended; the runner formats whatever the host
 * provides. The well-known keys are `provider`, `model`,
 * `sandbox`, `approval` (per the README).
 */
export type ReplProfile = Readonly<Record<string, unknown>>;

/**
 * F17.2.5: the profile loader. The host injects one via
 * `ReplOptions.profileLoader`. The runner calls `list()`
 * for `/profile` (no args) and `get(name)` for `/profile
 * <name>`.
 */
export interface ReplProfileLoader {
  /** List the available profile names. */
  list(): ReadonlyArray<string>;
  /** Get a profile by name, or `null` if it doesn't exist. */
  get(name: string): ReplProfile | null;
}

/**
 * F17.2: the context passed to a slash command's handler.
 * Carries the live agent + the parsed CLI args + the streams.
 * Commands can mutate `args` (e.g. `/sandbox` updates the
 * permission mode) and the next turn picks up the change.
 */
export interface ReplContext {
  /** The current Agent. Commands can mutate it via the
   *  public setters (`setModel`, `setAskHandler`,
   *  `setPermissionMode`, `clearSession`, `getCost`). */
  agent: Agent;
  /** Current parsed args. Mutable; commands update fields
   *  in place (e.g. `args.sandbox` after `/sandbox`). */
  args: RunParsedArgs;
  /** Streams. */
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Counter for turns (read-only; managed by `runRepl`). */
  turns: number;
  /** Counter for cost (read-only; managed by `runRepl`). */
  totalCostUsd: number;
  /** The live command registry. Set by `runRepl` before
   *  dispatching; the `/help` command reads it to enumerate
   *  the visible commands. The type is non-optional because
   *  the runner always sets it; if a host constructs a
   *  custom context (in tests), the field is required. */
  registry: ReplCommandRegistry;
  /** F17.2.5: optional scoreboard (F6). The `/scoreboard`
   *  command reads this; when undefined, the command prints
   *  "no scoreboard loaded". */
  scoreboard?: { entries?: () => ReadonlyArray<unknown> };
  /** F17.2.5: optional verifier rules. The `/rules` command
   *  reads this; when undefined, falls back to DEFAULT_RULES. */
  verifierRules?: ReadonlyArray<VerifierRule>;
  /** F17.2.5: optional profile loader. The `/profile` command
   *  reads this; when undefined, prints "no profile loader". */
  profileLoader?: ReplProfileLoader;
}

/**
 * F17.2: the shape of a slash command. The registry is
 * open: built-ins are registered in `commands.ts`, and
 * hosts can add project-specific commands via
 * `ReplOptions.customCommands`.
 *
 * **Built-ins always win** on name collision. The registry
 * resolves names case-sensitively (matches the input
 * exactly); `/HELP` does NOT match `/help`.
 */
export interface ReplCommand {
  /** The slash name, including the leading `/`. Example: `"/help"`. */
  name: string;
  /** One-line description shown in `/help`. */
  description: string;
  /** Hidden commands are not listed in `/help` (e.g. `/exit` is an alias of `/quit`). */
  hidden?: boolean;
  /**
   * Run the command. `args` is the tokenized args (the
   * leading slash-name is stripped; `parseCommandLine`
   * splits on whitespace, no quote handling in v0).
   *
   * **Throw** to surface an error to the user. The REPL
   * catches the throw and prints `error: <message>` to
   * stderr; the loop continues.
   */
  handler: (args: ReadonlyArray<string>, ctx: ReplContext) => Promise<void> | void;
}
