/**
 * Shared CLI argv flag helpers.
 */

import type { PermissionMode } from "../types.js";

/** The shared flags used by every subcommand. */
const COMMON_FLAGS = new Set(["--help", "--version", "--no-color", "--verbose", "--quiet"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Handle flags common to all subcommands: --help, --version,
 * --no-color, --verbose, --quiet. Returns `true` if handled
 * (caller should continue), `false` otherwise.
 */
export function handleCommonFlag(
  arg: string,
  out: { help: boolean; version: boolean; noColor: boolean; verbose: boolean; quiet: boolean },
): boolean {
  if (arg === "--help") {
    out.help = true;
    return true;
  }
  if (arg === "--version") {
    out.version = true;
    return true;
  }
  if (arg === "--no-color") {
    out.noColor = true;
    return true;
  }
  if (arg === "--verbose") {
    out.verbose = true;
    return true;
  }
  if (arg === "--quiet") {
    out.quiet = true;
    return true;
  }
  return false;
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  );
}

// Silence the "unused" warning for COMMON_FLAGS — it's kept as
// documentation of the shared surface; the actual handling is
// in `handleCommonFlag`.
void COMMON_FLAGS;
