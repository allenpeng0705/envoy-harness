/**
 * XDG / platform state-root resolution for envoy-harness.
 *
 * Default: `$XDG_STATE_HOME/envoy-harness` or
 * `~/.local/state/envoy-harness` (Windows: `%LOCALAPPDATA%/envoy-harness`).
 *
 * Some machines have a root-owned `~/.local/state` (common after a
 * `sudo`-installed CLI). Creating under that tree throws `EACCES` and
 * kills `--acp` / `--persist`. When the preferred root is not writable,
 * we fall back to `~/.envoy-harness` and best-effort migrate readable
 * files from the old location(s).
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

/** Written once into the destination after a migration attempt. */
export const STATE_MIGRATE_MARKER = ".envoy-state-migrated";

/** Top-level names we copy when moving between state roots. */
const STATE_ENTRIES = [
  "sessions",
  "history",
  "trusted-projects.json",
  "logs",
] as const;

/**
 * Legacy / alternate roots that may hold sessions after an XDG or
 * platform-path change (readable even when no longer writable).
 */
export function legacyEnvoyStateRoots(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string[] {
  const home = env["HOME"] ?? homedir();
  const preferred = resolvePreferredEnvoyStateRoot(env, homedir);
  const unixLegacy = path.join(home, ".local", "state", "envoy-harness");
  const out: string[] = [preferred];
  if (path.resolve(unixLegacy) !== path.resolve(preferred)) {
    out.push(unixLegacy);
  }
  return out;
}

function copyFileIfMissing(src: string, dest: string): void {
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirFilesIfMissing(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  let st: fs.Stats;
  try {
    st = fs.statSync(srcDir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    // Skip locks / temps; copy durable session JSONL (and peers).
    if (name.endsWith(".lock") || name.endsWith(".tmp")) continue;
    const from = path.join(srcDir, name);
    const to = path.join(destDir, name);
    try {
      const ent = fs.statSync(from);
      if (ent.isFile()) copyFileIfMissing(from, to);
    } catch {
      // ignore unreadable entries
    }
  }
}

/**
 * Best-effort one-shot copy of sessions / history / trust from `sources`
 * into `dest`. Never overwrites existing destination files. Safe to call
 * on every boot (marker short-circuits after the first attempt).
 */
export function migrateStateRootInto(
  dest: string,
  sources: readonly string[],
): void {
  const destResolved = path.resolve(dest);
  fs.mkdirSync(destResolved, { recursive: true });
  const marker = path.join(destResolved, STATE_MIGRATE_MARKER);
  if (fs.existsSync(marker)) return;

  for (const src of sources) {
    const srcResolved = path.resolve(src);
    if (srcResolved === destResolved) continue;
    if (!fs.existsSync(srcResolved)) continue;
    try {
      for (const name of STATE_ENTRIES) {
        const from = path.join(srcResolved, name);
        const to = path.join(destResolved, name);
        if (!fs.existsSync(from)) continue;
        const st = fs.statSync(from);
        if (st.isDirectory()) copyDirFilesIfMissing(from, to);
        else if (st.isFile()) copyFileIfMissing(from, to);
      }
    } catch {
      // best-effort — a partial migrate is better than failing boot
    }
  }

  try {
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: "wx" });
  } catch {
    // ignore races / read-only dest after mkdir
  }
}

/**
 * State root that recursive mkdir can use. Prefers the XDG path; if that
 * tree is not writable, returns `~/.envoy-harness` after migrating any
 * readable legacy data.
 */
export function resolveWritableEnvoyStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const preferred = resolvePreferredEnvoyStateRoot(env, homedir);
  const legacies = legacyEnvoyStateRoots(env, homedir);
  if (canCreateDirectory(preferred)) {
    // Preferred is usable — still pull from older unix path when it differs
    // (e.g. Windows now under LOCALAPPDATA, old data under ~/.local/state).
    migrateStateRootInto(
      preferred,
      legacies.filter((p) => path.resolve(p) !== path.resolve(preferred)),
    );
    return preferred;
  }
  const fallback = resolveFallbackEnvoyStateRoot(env, homedir);
  migrateStateRootInto(fallback, legacies);
  return fallback;
}
