/**
 * Process-tree termination with a TERM→KILL ladder, a PID-reuse fence,
 * and process-group targeting.
 *
 * **Three defects this closes** in the previous SIGKILL-only helper:
 *
 * 1. **No grace.** `SIGKILL` immediately denies a process any chance to
 *    flush, remove a lock file, or release a resource. Every serious
 *    supervisor sends `SIGTERM` first and escalates — codex uses a 3 s
 *    grace. A killed `git` or database client can leave a lock that the
 *    *next* run trips over, which is a stability bug, not a style issue.
 * 2. **No process group.** A shell that backgrounded work puts children
 *    in the same group; killing only the leader orphans them (survivors
 *    holding an inherited stdout pipe can hang the parent's `done`
 *    indefinitely). Kill the group when we own one.
 * 3. **PID reuse.** `process.kill(pid)` on a recycled PID kills an
 *    **unrelated** process — a real hazard for a long-lived session
 *    tearing down a job started minutes ago. Capture an identity first and
 *    re-verify before signalling.
 *
 * Every platform probe is injectable so the ladder and the fence are
 * testable without spawning anything.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Default grace between SIGTERM and SIGKILL. */
export const DEFAULT_TERM_GRACE_MS = 3_000;

/**
 * Identity of a process, sufficient to detect reuse.
 *
 * `startedAt` is the kernel's start time, not a wall-clock string we
 * formatted: comparing human-readable `ps` output is locale- and
 * timezone-dependent and was explicitly replaced in codex for that
 * reason.
 */
export interface ProcessIdentity {
  readonly pid: number;
  /** Opaque kernel start marker (`/proc/<pid>/stat` field 22 on Linux). */
  readonly startedAt: number | undefined;
}

export interface KillTreeOptions {
  /** Grace between SIGTERM and SIGKILL. `0` skips SIGTERM. */
  graceMs?: number;
  /** Kill the whole process group (`-pid`), not just the leader. */
  processGroup?: boolean;
  /** Recorded before signalling so a recycled PID can be detected. */
  identity?: ProcessIdentity;
  /** Sleep seam (tests). */
  wait?: (ms: number) => Promise<void>;
  /** Signal seam (tests). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Identity probe seam (tests). */
  readIdentity?: (pid: number) => ProcessIdentity | undefined;
  /** Platform seam (tests). */
  platform?: NodeJS.Platform;
}

/** Read a process's start marker, if the platform exposes one. */
export function readProcessIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): ProcessIdentity | undefined {
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  if (platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      // field 22 (1-based) is starttime; the comm field may contain spaces,
      // so split after the closing parenthesis.
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const starttime = Number(afterComm[19]);
      return Number.isFinite(starttime)
        ? { pid, startedAt: starttime }
        : { pid, startedAt: undefined };
    } catch {
      return undefined;
    }
  }
  // Other platforms: we can prove liveness but not identity.
  return { pid, startedAt: undefined };
}

/**
 * True when `pid` still refers to the process we captured.
 *
 * When the platform cannot report a start marker we fall back to
 * liveness only — which is strictly better than killing blind, but the
 * caller should know the fence is weaker there.
 */
export function identityMatches(
  identity: ProcessIdentity,
  readIdentity: (pid: number) => ProcessIdentity | undefined = readProcessIdentity,
): boolean {
  const current = readIdentity(identity.pid);
  if (current === undefined) return false; // gone
  if (identity.startedAt === undefined || current.startedAt === undefined) {
    // Liveness-only fence.
    return true;
  }
  return current.startedAt === identity.startedAt;
}

/**
 * Terminate `pid` and its descendants: SIGTERM (to the group when we own
 * one), a grace period, then SIGKILL. Never throws.
 */
export async function terminateProcessTree(
  pid: number | undefined | null,
  options: KillTreeOptions = {},
): Promise<void> {
  if (pid === undefined || pid === null || !Number.isFinite(pid) || pid <= 0) {
    return;
  }
  const platform = options.platform ?? process.platform;

  // PID-reuse fence: if the process we meant is gone (or was replaced),
  // signalling would hit an unrelated process.
  if (options.identity !== undefined) {
    const readIdentity = options.readIdentity ?? readProcessIdentity;
    if (!identityMatches(options.identity, readIdentity)) return;
  }

  if (platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      /* already gone */
    }
    return;
  }

  const kill =
    options.kill ??
    ((target: number, signal: NodeJS.Signals) => {
      process.kill(target, signal);
    });
  const graceMs = options.graceMs ?? DEFAULT_TERM_GRACE_MS;
  // A negative pid addresses the process GROUP, which is what catches
  // backgrounded children. Only valid when the caller created the child
  // detached (otherwise -pid is an unrelated group).
  const target = options.processGroup === true ? -pid : pid;

  const signal = (sig: NodeJS.Signals): boolean => {
    try {
      kill(target, sig);
      return true;
    } catch {
      // ESRCH: already gone. Try the leader as a fallback for the group case.
      if (target !== pid) {
        try {
          kill(pid, sig);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  };

  if (graceMs > 0) {
    if (!signal("SIGTERM")) return; // already gone
    const wait =
      options.wait ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    await wait(graceMs);
  }
  signal("SIGKILL");
}
