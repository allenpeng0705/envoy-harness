/**
 * XDG / platform state-root resolution for envoy-harness.
 *
 * Default: `$XDG_STATE_HOME/envoy-harness` or
 * `~/.local/state/envoy-harness` (Windows: `%LOCALAPPDATA%/envoy-harness`).
 *
 * Some machines have a root-owned `~/.local/state` (common after a
 * `sudo`-installed CLI). Creating under that tree throws `EACCES` and
 * kills `--acp` / `--persist`. When the preferred root is not writable,
 * we fall back to `~/.envoy-harness` so the host can still start.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Prefer `$XDG_STATE_HOME`, then `%LOCALAPPDATA%`, then `~/.local/state`. */
export function resolveXdgStateHome(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg.length > 0) return xdg;
  const localApp = env["LOCALAPPDATA"];
  if (localApp !== undefined && localApp.length > 0) return localApp;
  return path.join(env["HOME"] ?? homedir(), ".local", "state");
}

/**
 * Preferred envoy-harness state directory (may be unwritable).
 * Callers that must succeed on disk should use
 * {@link resolveWritableEnvoyStateRoot}.
 */
export function resolvePreferredEnvoyStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolveXdgStateHome(env, homedir), "envoy-harness");
}

/** Fallback when `~/.local/state` (or XDG) is not writable. */
export function resolveFallbackEnvoyStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(env["HOME"] ?? homedir(), ".envoy-harness");
}

/**
 * Walk up from `dir` until an existing ancestor is found; return whether
 * that ancestor is writable (so recursive mkdir of `dir` would succeed).
 */
export function canCreateDirectory(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      const st = fs.statSync(cur);
      if (!st.isDirectory()) return false;
      fs.accessSync(cur, fs.constants.W_OK);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const parent = path.dirname(cur);
        if (parent === cur) return false;
        cur = parent;
        continue;
      }
      return false;
    }
  }
}

/**
 * State root that recursive mkdir can use. Prefers the XDG path; if that
 * tree is not writable, returns `~/.envoy-harness`.
 */
export function resolveWritableEnvoyStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const preferred = resolvePreferredEnvoyStateRoot(env, homedir);
  if (canCreateDirectory(preferred)) return preferred;
  return resolveFallbackEnvoyStateRoot(env, homedir);
}
