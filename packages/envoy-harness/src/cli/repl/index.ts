/**
 * F17.1 + F17.2 + F17.2.5 — REPL public surface.
 *
 * Re-exports the public API for the REPL. The CLI runner imports
 * `runRepl` from here; tests can import the same entry point.
 *
 * **Stability:** the surface here is F17.1 + F17.2 + F17.2.5.
 * F17.3 will add history helpers; F17.4 will add e2e tests (no
 * public API).
 */

export { runRepl } from "./loop.js";
export { BUILTIN_COMMANDS } from "./commands.js";
export { BUILTIN_INFO_COMMANDS } from "./commands-info.js";
export {
  ReplCommandRegistry,
  dispatchCommand,
  parseCommandLine,
  type DispatchResult,
} from "./registry.js";
export type {
  LineReader,
  ReplCommand,
  ReplContext,
  ReplOptions,
  ReplProfile,
  ReplProfileLoader,
  ReplResult,
} from "./types.js";
