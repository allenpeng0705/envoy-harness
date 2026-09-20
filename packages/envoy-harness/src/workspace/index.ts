/**
 * Workspace (project) registry — public surface.
 *
 * The registry is global to the machine (one ordered list of projects),
 * not per-project: a host that wants "open a project" needs a place to
 * remember the projects that are *not* the current directory.
 */

import * as os from "node:os";
import * as path from "node:path";

export {
  WORKSPACE_FILE_FORMAT_VERSION,
  WorkspaceEntrySchema,
  WorkspaceError,
  WorkspaceFileSchema,
  createFileWorkspaceRegistry,
  isWithinRoots,
  normalizeWorkspacePath,
  type FileWorkspaceRegistryOptions,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspaceRegistry,
} from "./registry.js";

/** Default on-disk location, alongside the credentials file. */
export function defaultWorkspacesFilePath(): string {
  return path.join(os.homedir(), ".config", "envoy-harness", "workspaces.json");
}

/**
 * Allowed workspace roots from `ENVOY_WORKSPACE_ROOTS`
 * (`path.delimiter`-separated; `:` on POSIX, `;` on Windows).
 *
 * **Why this exists.** Naming any directory is fine for a CLI on the
 * operator's own machine, but a host whose project API is reachable from
 * anywhere else should be able to bound it. Empty/unset means unbounded —
 * the local default — and the hosts that can be bound to a non-loopback
 * address pass this through so an operator has one switch to constrain it.
 */
export function workspaceRootsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env["ENVOY_WORKSPACE_ROOTS"];
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(path.delimiter)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}
