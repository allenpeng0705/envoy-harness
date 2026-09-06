/**
 * Local exec-world — FS/shell on this process (default).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { killProcessTree } from "../process/kill-tree.js";
import type {
  ExecShellResult,
  ExecWorld,
} from "./types.js";
import { ExecWorldError } from "./types.js";

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
        const truncated = buf.byteLength > cap;
        const slice = truncated ? buf.subarray(0, cap) : buf;
        return {
          content: slice.toString("utf8"),
          truncated,
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
        const child = spawn("sh", ["-c", request.command], {
          cwd: request.cwd,
          env: request.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          killProcessTree(child.pid);
        }, timeout);

        const onAbort = () => {
          killProcessTree(child.pid);
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
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(new ExecWorldError(err.message, "IO"));
        });
        child.on("close", (code) => {
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
