/**
 * Auto-run permission policy (Codex / Claude-style modes) for ACP
 * sessions, the TUI, and hosts:
 *
 * - `always-confirm` — ask for every tool.
 * - `safe-only` (default) — auto-allow read-only tools, safe bash,
 *   and in-workspace file writes/edits; ask for everything else.
 * - `off` — never ask (auto-allow everything).
 *
 * This is the session-level counterpart of the EnvoyMesh
 * `envoyHarnessAutoRunPolicy`; keeping the classifier here lets the TUI
 * and any ACP host offer the same three modes without importing EnvoyMesh.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";

/** Read-only / low-risk tools that `safe-only` may auto-allow. */
export const AUTO_RUN_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "git",
  "session_query",
  "list_peers",
  "relay_status",
  "peers",
]);

/** File-mutation tools whose path args can be checked against the workspace. */
export const AUTO_RUN_WORKSPACE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "apply_patch",
]);

export type AutoRunPolicy = "always-confirm" | "safe-only" | "off";

export type ShouldAskUnderAutoRunOptions = {
  /** Session workspace root; required to auto-allow in-workspace writes/edits. */
  workspaceRoot?: string;
};

/**
 * Single, read-only bash commands that `safe-only` may auto-allow.
 *
 * Intentionally absent (escape / mutate):
 * - `env` / `command` — can prefix arbitrary programs (`env rm …`)
 * - `find` — `-delete` / `-exec` mutate the tree
 * - `git config` — mutates git settings
 */
const SAFE_BASH_RE =
  /^\s*(?:ls|cat|pwd|whoami|date|which|file|stat|du|df|grep|rg|head|tail|wc|echo|printf|printenv|dirname|basename|readlink|realpath|type|test|true|false|git\s+(?:status|log|diff|show|branch|remote|rev-parse|symbolic-ref|ls-files|ls-tree|describe|shortlog|blame|grep|submodule\s+status))(?:\s|$)/;

export function isAutoRunSafeBashCommand(
  command: string | undefined,
): boolean {
  if (!command || typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Reject anything compound or redirecting — a "safe" auto-run must be
  // a single read-only command with no shell metacharacters.
  if (/[;&|`]|\$\(|>|<|\n/.test(trimmed)) return false;
  return SAFE_BASH_RE.test(trimmed);
}

/**
 * Resolve `absolutePath` through symlinks. If the leaf does not exist yet (new
 * write), resolve the deepest existing ancestor and re-join the missing suffix.
 * Fail closed when nothing on the chain can be resolved.
 */
function resolveThroughSymlinks(absolutePath: string): string | undefined {
  try {
    return realpathSync(absolutePath);
  } catch {
    const missing: string[] = [];
    let cursor = absolutePath;
    for (;;) {
      missing.push(path.basename(cursor));
      const parent = path.dirname(cursor);
      if (parent === cursor) return undefined;
      try {
        return path.join(realpathSync(parent), ...missing.reverse());
      } catch {
        cursor = parent;
      }
    }
  }
}

/**
 * Whether `filePath` resolves under `workspaceRoot` after symlink resolution.
 * Symlinks that escape the project are not auto-allowed (ask instead).
 */
export function isPathInsideWorkspace(
  filePath: string,
  workspaceRoot: string,
): boolean {
  const rootReal = resolveThroughSymlinks(path.resolve(workspaceRoot));
  if (rootReal === undefined) return false;
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(rootReal, filePath);
  const resolved = resolveThroughSymlinks(absolute);
  if (resolved === undefined) return false;
  if (resolved === rootReal) return true;
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return resolved.startsWith(prefix);
}

function mutationPathFromArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const name of ["path", "file_path", "filePath", "filepath"]) {
    const value = record[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Whether the session should ASK for this tool call under the policy.
 * Returns `undefined` when the policy is not set (caller falls back to
 * its own shouldAsk).
 */
export function shouldAskUnderAutoRun(
  policy: AutoRunPolicy | undefined,
  toolName: string,
  args?: unknown,
  options?: ShouldAskUnderAutoRunOptions,
): boolean | undefined {
  if (policy === "off") return false;
  if (policy === "always-confirm") return true;
  if (policy === "safe-only") {
    if (AUTO_RUN_SAFE_TOOLS.has(toolName)) return false;
    if (toolName === "bash") {
      const command =
        args !== null &&
        typeof args === "object" &&
        "command" in args &&
        typeof (args as { command?: unknown }).command === "string"
          ? (args as { command: string }).command
          : undefined;
      return !isAutoRunSafeBashCommand(command);
    }
    // Project change: sandbox already blocks out-of-workspace writes — do not
    // stop the turn for every in-project edit (matches EnvoyDev mode copy).
    if (AUTO_RUN_WORKSPACE_MUTATION_TOOLS.has(toolName)) {
      const workspaceRoot = options?.workspaceRoot?.trim();
      const filePath = mutationPathFromArgs(args);
      if (
        workspaceRoot !== undefined &&
        workspaceRoot !== "" &&
        filePath !== undefined &&
        isPathInsideWorkspace(filePath, workspaceRoot)
      ) {
        return false;
      }
      return true;
    }
    return true;
  }
  return undefined;
}
