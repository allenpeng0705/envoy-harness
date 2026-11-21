/**
 * Platform shell invocation for bash / exec-world tools.
 * win32 prefers pwsh, then powershell.exe; POSIX uses sh -c.
 */

import { execFileSync } from "node:child_process";

export interface ShellInvocation {
  file: string;
  args: string[];
  kind: "pwsh" | "powershell" | "sh";
}

let cachedWinShell: ShellInvocation | undefined;

function whichWin(cmd: string): boolean {
  try {
    execFileSync("where.exe", [cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveShellInvocation(
  platform: NodeJS.Platform = process.platform,
  command: string,
): ShellInvocation {
  if (platform !== "win32") {
    return { file: "sh", args: ["-c", command], kind: "sh" };
  }
  if (cachedWinShell === undefined) {
    if (whichWin("pwsh")) {
      cachedWinShell = {
        file: "pwsh",
        args: ["-NoProfile", "-NonInteractive", "-Command"],
        kind: "pwsh",
      };
    } else if (whichWin("powershell.exe")) {
      cachedWinShell = {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command"],
        kind: "powershell",
      };
    } else {
      // Last resort for runtime spawn; doctor reports unavailable.
      cachedWinShell = {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command"],
        kind: "powershell",
      };
    }
  }
  return {
    file: cachedWinShell.file,
    args: [...cachedWinShell.args, command],
    kind: cachedWinShell.kind,
  };
}

/** True when win32 has pwsh or powershell.exe on PATH (`where.exe`). */
export function windowsShellAvailable(): boolean {
  return whichWin("pwsh") || whichWin("powershell.exe");
}

/** Test helper — clear win32 shell cache. */
export function resetShellInvocationCache(): void {
  cachedWinShell = undefined;
}
