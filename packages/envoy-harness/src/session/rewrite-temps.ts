/**
 * Reaping orphaned rewrite temp files.
 *
 * **The litter this cleans up.** `DurableLineWriter.rewrite()` publishes
 * atomically: it writes `<file>.rewrite-<pid>.tmp`, fsyncs it, renames it
 * over the target, then fsyncs the directory. If the process dies between
 * the write and the rename — SIGKILL, a power cut, a container eviction —
 * that temp file stays in the session directory **forever**. Nothing else
 * removes it, so they accumulate one per crash, per session.
 *
 * The session file itself is never at risk (the rename is atomic, so the
 * previous transcript survives intact). This is litter, not data loss —
 * but it is unbounded litter in a directory users are told to inspect
 * (`ls ~/.local/state/envoy-harness/sessions`).
 *
 * **Why this is safe to delete.** Reaping runs only while the caller holds
 * the session's **exclusive write lease**. A rewrite temp for this exact
 * file can only be created by a writer of this file, i.e. by a lease
 * holder, so holding the lease means every matching temp belongs to a
 * writer that is gone or incorrect. That is the same staleness model the
 * lease itself uses — this adds no new trust assumption.
 *
 * On top of that, four independent guards keep the blast radius at zero:
 *
 * 1. **Exact name.** The name must be `<exact session filename>.rewrite-<digits>.tmp`.
 *    A prefix match would let `a.jsonl.rewrite-1.tmp` be deleted while
 *    cleaning up `a.jsonl.rewrite-10.tmp`'s sibling `a.jsonl`; anchoring on
 *    the full basename prevents any such collision.
 * 2. **Same directory**, derived from the session path — never a recursive
 *    walk, so nothing outside that one directory is ever touched.
 * 3. **Not our own pid.** We could not have a temp in flight at open time,
 *    but the check makes that explicit rather than incidental.
 * 4. **Age floor** (default 60 s). A live rewrite finishes in
 *    milliseconds, so any temp older than a minute is certainly orphaned.
 *    This is what protects a **shared filesystem** (NFS/containers) from
 *    the worst case: a foreign host whose pid merely *looks* dead locally
 *    because pids are not comparable across hosts.
 *
 * Best-effort by design: reaping never fails the caller. A temp that
 * cannot be removed now is a temp that will be removed next time.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Infix between the session filename and the writer pid. */
export const REWRITE_TEMP_INFIX = ".rewrite-";

/** The temp path a rewrite by `pid` publishes through. */
export function rewriteTempPath(filePath: string, pid: number): string {
  return `${filePath}${REWRITE_TEMP_INFIX}${pid}.tmp`;
}

/**
 * The writer pid named by `name`, when `name` is a rewrite temp for
 * exactly `filePath`; otherwise `undefined`.
 *
 * Deliberately strict: `undefined` for any other file, any non-numeric pid,
 * and any extra suffix.
 */
export function rewriteTempPid(
  filePath: string,
  name: string,
): number | undefined {
  const prefix = `${path.basename(filePath)}${REWRITE_TEMP_INFIX}`;
  if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return undefined;
  const middle = name.slice(prefix.length, -".tmp".length);
  if (!/^\d+$/.test(middle)) return undefined;
  const pid = Number(middle);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Default age floor: a live rewrite never takes a minute. */
export const DEFAULT_REAP_MIN_AGE_MS = 60_000;

export interface ReapRewriteTempsOptions {
  /**
   * Age floor in ms. A temp whose mtime is newer is left alone. `0`
   * disables the floor (tests, or a host that knows it has an exclusive
   * filesystem).
   */
  minAgeMs?: number;
  /** Process-liveness probe. Defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Injectable for tests / a future non-node filesystem seam. */
  listDir?: (dir: string) => Promise<string[]>;
  statMtimeMs?: (filePath: string) => Promise<number>;
  unlink?: (filePath: string) => Promise<void>;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ReapRewriteTempsResult {
  /** Temp paths removed. */
  readonly removed: ReadonlyArray<string>;
  /** Candidates left alone, with the reason (for the trace / doctor). */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove orphaned rewrite temps for `filePath`.
 *
 * Never throws and never rejects: every failure (a missing directory, an
 * unreadable entry, a refused unlink) is reported as a skip. Callers run
 * this while holding the write lease and must not fail an `open` because
 * a piece of litter could not be swept.
 */
export async function reapStaleRewriteTemps(
  filePath: string,
  options: ReapRewriteTempsOptions = {},
): Promise<ReapRewriteTempsResult> {
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const dir = path.dirname(filePath);
  const minAgeMs = options.minAgeMs ?? DEFAULT_REAP_MIN_AGE_MS;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const now = options.now ?? (() => Date.now());
  const listDir = options.listDir ?? ((d: string) => fs.readdir(d));
  const statMtimeMs =
    options.statMtimeMs ??
    (async (p: string) => (await fs.stat(p)).mtimeMs);
  const unlink = options.unlink ?? ((p: string) => fs.unlink(p));

  let names: string[];
  try {
    names = await listDir(dir);
  } catch {
    // No directory → nothing to sweep. Not an error.
    return { removed, skipped };
  }

  for (const name of names) {
    const pid = rewriteTempPid(filePath, name);
    if (pid === undefined) continue; // not ours — never touch it
    const full = path.join(dir, name);
    if (pid === process.pid) {
      skipped.push({ path: full, reason: "current process writer" });
      continue;
    }
    if (isAlive(pid)) {
      skipped.push({ path: full, reason: `pid ${pid} is alive` });
      continue;
    }
    if (minAgeMs > 0) {
      let mtimeMs: number;
      try {
        mtimeMs = await statMtimeMs(full);
      } catch {
        skipped.push({ path: full, reason: "stat failed" });
        continue;
      }
      const age = now() - mtimeMs;
      if (age < minAgeMs) {
        skipped.push({
          path: full,
          reason: `newer than the ${minAgeMs}ms age floor`,
        });
        continue;
      }
    }
    try {
      await unlink(full);
      removed.push(full);
    } catch {
      skipped.push({ path: full, reason: "unlink failed" });
    }
  }
  return { removed, skipped };
}
