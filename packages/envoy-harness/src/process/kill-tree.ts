/**
 * R6.1 — kill a process and its descendants.
 *
 * On Windows, Node's `ChildProcess.kill` / `process.kill(pid)` only
 * terminates the direct child. Nested `cmd.exe` / shell grandchildren
 * survive. Use `taskkill /T /F` for a best-effort tree kill.
 *
 * On Unix, `SIGKILL` the pid (callers that need SIGTERM-first grace
 * should send SIGTERM themselves, then call this for the hard kill).
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
