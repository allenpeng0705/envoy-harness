/**
 * Immediate, best-effort hard kill of a process tree.
 *
 * **Prefer {@link reapChild} (or {@link terminateProcessTree}) for anything
 * you spawned.** This helper is deliberately the *last resort*: it sends
 * `SIGKILL` with no grace, no process-group targeting, no PID-reuse fence,
 * and no wait for the stdio pipes to close. That combination is what let a
 * backgrounded descendant keep a tool's stdout pipe open and wedge the
 * agent forever — see `reap.ts` for the fix and the reasoning.
 *
 * Reach for this only where the event loop is already gone (`process.on
 * ("exit")`, a last-chance cleanup handler) and signalling synchronously
 * is the whole requirement.
 *
 * On Windows, Node's `ChildProcess.kill` / `process.kill(pid)` only
 * terminates the direct child. Nested `cmd.exe` / shell grandchildren
 * survive, so this shells out to `taskkill /T /F` for a best-effort tree
 * kill.
 *
 * @returns nothing; never throws (an already-reaped pid is a no-op).
 */
import { spawnSync } from "node:child_process";

/**
 * Best-effort kill of `pid` and descendants.
 * No-ops for missing / invalid pids; never throws.
 */
export function killProcessTree(pid: number | undefined | null): void {
  if (pid === undefined || pid === null || !Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // already gone or taskkill unavailable
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ESRCH — already gone
  }
}
