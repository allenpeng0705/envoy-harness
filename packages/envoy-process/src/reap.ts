/**
 * Reaping a child we spawned.
 *
 * **The two failure modes this closes** (both observed as "the tool
 * hangs and the agent stops responding"):
 *
 * 1. **A grandchild keeps the stdout pipe open.** `sh -c 'daemon &'`
 *    exits immediately, but the backgrounded process inherits the write
 *    end of our stdout pipe. We kill the shell, yet `close` never fires
 *    because the pipe is still open, so the tool's promise never
 *    settles and the turn is wedged forever. Killing the *process group*
 *    handles the common case; a bounded settle window plus an explicit
 *    pipe teardown handles the process that escaped the group
 *    (`setsid`, double-fork, a daemon).
 * 2. **A signal-killed child never produces an exit code.** `close`
 *    reports `code === null` when a process dies from a signal, so a
 *    settle predicate written as `if (code === null) return` waits for an
 *    event that will never come. {@link reapChild} keys off the `close`
 *    event itself rather than the code.
 *
 * The ladder itself (SIGTERM → grace → SIGKILL) and the PID-reuse fence
 * live in `terminate.ts`; this module is the *caller-side* policy: capture
 * an identity at spawn time, and never let a dead-but-unreaped child hold
 * the event loop.
 */

import type { ChildProcess } from "node:child_process";

import {
  readProcessIdentity,
  terminateProcessTree,
  type ProcessIdentity,
} from "./terminate.js";

/** How long we wait for `close` after the hard kill before forcing it. */
export const DEFAULT_REAP_SETTLE_MS = 500;

/**
 * Default SIGTERM→SIGKILL grace when reaping a child.
 *
 * Deliberately shorter than {@link DEFAULT_TERM_GRACE_MS} (3s): a reap is
 * almost always triggered by something the user is **waiting on** (a tool
 * timeout, a cancel, a hook deadline), so every millisecond of grace is
 * latency the turn pays. Long-lived background jobs that want a longer
 * cleanup window pass `graceMs` explicitly.
 */
export const DEFAULT_REAP_GRACE_MS = 1_000;

export interface ReapChildOptions {
  /** Grace between SIGTERM and SIGKILL. Default {@link DEFAULT_REAP_GRACE_MS}. */
  graceMs?: number;
  /** Bounded wait for `close` after the kill ladder finishes. */
  settleMs?: number;
  /** Signal the whole process group (`-pid`). Only when spawned detached. */
  processGroup?: boolean;
  /** Identity captured at spawn time; rejects a recycled pid. */
  identity?: ProcessIdentity;
  /** Invoked when the pipes had to be torn down to force settlement. */
  onForceClose?: () => void;
  /**
   * The kill ladder's own seams, forwarded verbatim. Production callers
   * omit them; tests inject them so no real process is signalled.
   */
  wait?: (ms: number) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  readIdentity?: (pid: number) => ProcessIdentity | undefined;
  platform?: NodeJS.Platform;
}

/**
 * Capture the identity of a freshly-spawned child so a later kill cannot
 * hit a recycled pid.
 *
 * Call this immediately after `spawn` — the value is only meaningful
 * while the child is alive.
 */
export function captureChildIdentity(
  child: Pick<ChildProcess, "pid">,
): ProcessIdentity | undefined {
  const pid = child.pid;
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return undefined;
  return readProcessIdentity(pid);
}

/**
 * Terminate `child` and guarantee its pipes close.
 *
 * @returns `true` when the settle window expired and the pipes had to be
 *   torn down (the child — or one of its descendants — outlived the
 *   kill ladder).
 */
export async function reapChild(
  child: ChildProcess,
  options: ReapChildOptions = {},
): Promise<boolean> {
  // A child is only *closed* once the `close` event has fired: the exit
  // code is set much earlier (on `exit`), and a backgrounded descendant
  // can hold the stdio pipes open long after. Keying the fast path off the
  // exit code alone would skip the teardown in exactly the case it exists
  // for.
  const pipesClosed =
    (child.stdout === null ||
      child.stdout.destroyed ||
      child.stdout.readableEnded) &&
    (child.stderr === null ||
      child.stderr.destroyed ||
      child.stderr.readableEnded);
  const alreadyClosed =
    (child.exitCode !== null || child.signalCode !== null) && pipesClosed;
  // Nothing to do: the child exited and both pipes are closed, so
  // signalling would only risk hitting a recycled pid.
  if (alreadyClosed) return false;
  // Register the listener BEFORE the first await: `close` can fire while
  // the ladder is sleeping through its grace period.
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });

  await terminateProcessTree(child.pid, {
    graceMs: options.graceMs ?? DEFAULT_REAP_GRACE_MS,
    ...(options.processGroup !== undefined
      ? { processGroup: options.processGroup }
      : {}),
    ...(options.identity !== undefined ? { identity: options.identity } : {}),
    ...(options.wait !== undefined ? { wait: options.wait } : {}),
    ...(options.kill !== undefined ? { kill: options.kill } : {}),
    ...(options.readIdentity !== undefined
      ? { readIdentity: options.readIdentity }
      : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
  });

  const settled = await withTimeout(closed, options.settleMs ?? DEFAULT_REAP_SETTLE_MS);
  if (settled) return false;

  // The child is gone but something still holds its stdout/stderr.
  // Destroying our end is what lets the caller's `close` handler run.
  destroyQuietly(child.stdout);
  destroyQuietly(child.stderr);
  options.onForceClose?.();
  return true;
}

function destroyQuietly(stream: { destroy?: () => void } | null | undefined): void {
  try {
    stream?.destroy?.();
  } catch {
    /* already destroyed */
  }
}

/**
 * `true` when `promise` settled within `ms`.
 *
 * The timer is unref'd so a pending settle window never keeps the
 * harness process alive on its own.
 */
function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
