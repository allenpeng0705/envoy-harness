/**
 * F17.1 — REPL public surface.
 *
 * Re-exports the public API for the REPL. The CLI runner imports
 * `runRepl` from here; tests can import the same entry point.
 *
 * **Stability:** the surface here is F17.1. F17.2 will add
 * `ReplCommand` and the registry; F17.3 will add history helpers.
 */

export { runRepl } from "./loop.js";
export type { LineReader, ReplOptions, ReplResult } from "./types.js";
