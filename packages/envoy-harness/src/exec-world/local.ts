/**
 * Local exec-world — FS/shell on this process (default).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { captureChildIdentity, reapChild } from "../process/reaper.js";
import type {
  ExecShellResult,
  ExecWorld,
} from "./types.js";
import { ExecWorldError } from "./types.js";
import { decodeUtf8Within } from "../util/retention.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ExecWorldError("exec-world aborted", "TRANSPORT");
  }
}

export function createLocalExecWorld(): ExecWorld {
  return {
    target: { kind: "local" },

    async readFile(filePath, options, signal) {
      throwIfAborted(signal);
      const cap = options.maxBytes ?? 1024 * 1024;
      try {
        const buf = await fs.readFile(filePath);
        const decoded = decodeUtf8Within(buf, cap);
        return {
          content: decoded.text,
          truncated: decoded.truncated,
          byteLength: buf.byteLength,
        };
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        throw new ExecWorldError(
          `${e.code ?? "IO"}: ${e.message}`,
          e.code === "ENOENT" ? "NOT_FOUND" : "IO",
        );
      }
    },

    async writeFile(filePath, content, options, signal) {
      throwIfAborted(signal);
      try {
        if (options.createDirectories) {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
        }
        await fs.writeFile(filePath, content, "utf8");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        throw new ExecWorldError(
          `${e.code ?? "IO"}: ${e.message}`,
          "IO",
        );
      }
    },

    async runShell(request, signal) {
      throwIfAborted(signal);
      const timeout = request.timeoutMs ?? 30_000;
      return new Promise<ExecShellResult>((resolve, reject) => {
        // `detached` on POSIX: own process group, so the kill ladder can
        // address the whole tree without touching the harness's group.
        const detached = process.platform !== "win32";
        const child = spawn("sh", ["-c", request.command], {
          cwd: request.cwd,
          env: request.env ?? process.env,
          detached,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const identity = captureChildIdentity(child);
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        const kill = (): void => {
          // TERM → grace → KILL against the group, then a bounded wait for
          // the pipes; a backgrounded grandchild would otherwise keep
          // `close` from ever firing and hang the turn.
          void reapChild(child, {
            processGroup: detached,
            ...(identity !== undefined ? { identity } : {}),
            onForceClose: () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              signal.removeEventListener("abort", onAbort);
              resolve({ stdout, stderr, exitCode: 137, timedOut });
            },
          });
        };

        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeout);

        const onAbort = (): void => {
          kill();
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new ExecWorldError("exec-world aborted", "TRANSPORT"));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });

        child.stdout?.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        child.stderr?.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(new ExecWorldError(err.message, "IO"));
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve({
            stdout,
            stderr,
            exitCode: code,
            timedOut,
          });
        });
      });
    },
  };
}
