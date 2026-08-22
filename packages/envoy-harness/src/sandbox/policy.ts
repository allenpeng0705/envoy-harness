/**
 * Phase F — SandboxPolicy → landlock grants / seatbelt profile.
 */

import type { SandboxPolicy } from "../types.js";

/** Filesystem grants for landlock-run (`--ro` / `--rw`). */
export interface LandlockGrants {
  readonly readOnly: readonly string[];
  readonly readWrite: readonly string[];
}

/**
 * Translate policy into landlock-run grants.
 *
 * Allow-list: grant read-only `/` so binaries stay runnable,
 * then add write roots from the policy.
 */
export function policyToLandlockGrants(
  policy: SandboxPolicy,
  cwd: string,
): LandlockGrants {
  const readWrite: string[] = [];
  if (policy.mode === "workspace-write") {
    const roots =
      policy.writableRoots.length > 0 ? [...policy.writableRoots] : [cwd];
    readWrite.push(...roots);
  }
  if (policy.slashTmpWritable) {
    readWrite.push("/tmp");
  }
  return {
    readOnly: ["/"],
    readWrite: dedupe(readWrite),
  };
}

/**
 * Build a macOS seatbelt (`sandbox-exec -p`) profile from policy.
 *
 * **Profile breadth (intentional, defense-in-depth):** the
 * default rules grant `(allow process*)`, `(allow mach*)`,
 * `(allow file-read*)` and `(allow signal)` so common CLI
 * binaries (Node, sh, git) work inside the sandbox. The 6
 * bash validators (parse-time command rejection in
 * `permissions/`) are the v1 *enforcement* layer; the
 * seatbelt profile is the *containment* layer that prevents
 * the wrapped command from touching the host filesystem
 * outside the policy's writable roots. A user who wants a
 * tighter profile can supply a custom `SandboxExecutor`.
 */
export function policyToSeatbeltProfile(
  policy: SandboxPolicy,
  cwd: string,
): string {
  if (policy.mode === "danger-full-access" || policy.backend === "none") {
    return "(version 1)\n(allow default)\n";
  }

  const writeRoots: string[] = [];
  if (policy.mode === "workspace-write") {
    const roots =
      policy.writableRoots.length > 0 ? [...policy.writableRoots] : [cwd];
    writeRoots.push(...roots);
  }
  if (policy.slashTmpWritable) writeRoots.push("/tmp");

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow mach*)",
    "(allow file-read*)",
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-ioctl (literal "/dev/null"))',
  ];
  for (const root of dedupe(writeRoots)) {
    lines.push(
      `(allow file-write* (subpath "${escapeSeatbeltPath(root)}"))`,
    );
  }
  if (!policy.networkAccess) {
    lines.push("(deny network*)");
  } else {
    lines.push("(allow network*)");
  }
  return `${lines.join("\n")}\n`;
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Escape a path for safe interpolation into a seatbelt
 * profile line (`(allow file-write* (subpath "<path>"))`).
 *
 * Seatbelt's profile parser is line-oriented and treats
 * `\\` and `"` as significant inside a literal. A path
 * containing a newline could break out of the surrounding
 * line and inject a new rule. Strip the three dangerous
 * characters (backslash, double-quote, newline) and any
 * carriage return for defense-in-depth.
 */
function escapeSeatbeltPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "")
    .replace(/\r/g, "");
}
