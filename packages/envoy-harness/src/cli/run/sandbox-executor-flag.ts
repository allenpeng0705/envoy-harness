/**
 * Resolve `--sandbox-executor` into an Agent sandboxExecutor option.
 * Shared by one-shot, REPL, and ACP.
 */

import { policyFromMode } from "../../permissions/policy.js";
import { resolveSandboxExecutor } from "../../sandbox/resolve.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import type { PermissionMode } from "../../types.js";
import type { RunParsedArgs } from "../argv-types.js";

export function resolveSandboxExecutorFromArgs(
  parsed: Pick<RunParsedArgs, "sandbox" | "sandboxExecutor">,
  cwd: string,
): SandboxExecutor | undefined {
  if (parsed.sandboxExecutor === undefined) return undefined;
  const force:
    | "landlock"
    | "seatbelt"
    | "windows-sandbox"
    | "noop"
    | undefined =
    parsed.sandboxExecutor === "none" ? "noop" : parsed.sandboxExecutor;
  return resolveSandboxExecutor({
    policy: policyFromMode(
      (parsed.sandbox as PermissionMode | undefined) ?? "read-only",
      cwd,
    ),
    force,
  });
}
