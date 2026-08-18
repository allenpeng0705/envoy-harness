/**
 * pathValidation — fifth of the 6 bash validators.
 *
 * **Rule:** in workspace-write mode, every absolute or `~`-prefixed
 * path in `argv` must resolve to a path under one of the
 * `writable_roots` (or the cwd if no roots are configured).
 *
 * **Why per-argument and not command-string scan?** the argv is
 * already tokenized. Scanning the command string for paths is
 * brittle (paths can be inside quotes, behind variables, escaped).
 * Tokenized argv is what the shell will actually pass to the
 * command.
 *
 * **Why block on argv-only and not on every literal in the string?**
 * because `cd /etc && ls` is two commands; the second is `ls` which
 * has no path argument. Per-argument scan catches the dangerous
 * pattern (passing `/etc/foo` to a write tool) without false
 * positives on shell-control words.
 *
 * **Why `path.resolve`?** `argv` paths may be relative. We resolve
 * them against `cwd` so a relative `../foo` is checked against the
 * roots correctly.
 *
 * **Design doc:** §6.2 of `docs/design.md`.
 */

import * as os from "node:os";
import * as path from "node:path";

import type { BashValidationInput, BashValidator, BashVerdict } from "../../types.js";

/**
 * Resolve a `~`-prefixed argument to an absolute path.
 *
 * - `~` or `~/foo` → the current user's home directory.
 * - `~user` or `~user/foo` → `/home/user` (Linux default). The actual
 *   user's home would require a name service lookup; we use the
 *   Linux convention which is what EnvoyMesh targets. macOS users
 *   with non-standard home paths should override the policy.
 *
 * Returns the original `arg` unchanged if it doesn't start with `~`.
 */
function expandTilde(arg: string): string {
  if (!arg.startsWith("~")) return arg;
  if (arg === "~" || arg.startsWith("~/")) {
    const home = os.homedir();
    return arg === "~" ? home : path.join(home, arg.slice(2));
  }
  // ~user or ~user/foo
  const slashIdx = arg.indexOf("/");
  const user = slashIdx === -1 ? arg.slice(1) : arg.slice(1, slashIdx);
  const rest = slashIdx === -1 ? "" : arg.slice(slashIdx);
  // Linux convention: home dirs live under /home. Real systems may
  // differ; this is the common case.
  return `/home/${user}${rest}`;
}

export const pathValidation: BashValidator = {
  name: "path",
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (input.policy.mode !== "workspace-write") return { kind: "allow" };

    const roots =
      input.policy.writableRoots.length > 0
        ? input.policy.writableRoots
        : [input.cwd];

    for (const arg of input.argv) {
      if (arg.startsWith("/") || arg.startsWith("~")) {
        const expanded = arg.startsWith("~")
          ? expandTilde(arg)
          : path.resolve(input.cwd, arg);
        if (!roots.some((root) => expanded.startsWith(root))) {
          return {
            kind: "block",
            reason: `path ${arg} is outside writable_roots`,
          };
        }
      }
    }
    return { kind: "allow" };
  },
};
