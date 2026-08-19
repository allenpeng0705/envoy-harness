/**
 * Shared `SandboxPolicy` builder.
 *
 * **Why a single module:** the agent and the bash tool each
 * used to derive the policy from the session's permission
 * mode in two separate copies that could drift (implementation-
 * plan risk 5.1). Both now import `policyFromMode` from here.
 *
 * **Stability:** additive. `policyFromMode` is the public
 * surface.
 */

import type { PermissionMode, SandboxPolicy } from "../types.js";

/**
 * Build a `SandboxPolicy` from a permission mode and cwd.
 *
 * | mode               | backend              | network |
 * |--------------------|----------------------|---------|
 * | read-only          | linux-landlock       | no      |
 * | workspace-write    | linux-landlock       | no      |
 * | danger-full-access | none                 | yes     |
 */
export function policyFromMode(
  mode: PermissionMode,
  cwd: string,
): SandboxPolicy {
  if (mode === "danger-full-access") {
    return {
      mode,
      approval: "never",
      backend: "none",
      writableRoots: [],
      networkAccess: true,
      slashTmpWritable: true,
    };
  }
  return {
    mode,
    approval: "on-request",
    backend: "linux-landlock",
    writableRoots: mode === "workspace-write" ? [cwd] : [],
    networkAccess: false,
    slashTmpWritable: true,
  };
}
