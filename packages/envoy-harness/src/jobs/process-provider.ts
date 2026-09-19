/**
 * Phase C / Item 7 — child-process job producer.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { captureChildIdentity, reapChild } from "../process/reaper.js";
import type { JobHooks, JobOutcome } from "./types.js";

export interface ProcessJobOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Soft cap on retained output bytes (default 256 KiB). */
  outputLimitBytes?: number;
  /** Grace period before SIGKILL after cancel (default 2s; Unix only). */
  killGraceMs?: number;
  /** Live combined stdout/stderr chunks (UTF-8). */
  onOutput?: (chunk: string) => void;
}

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;

/** Build {@link JobHooks} for a shell command. Call from `JobStart.run()`. */
export function createProcessJobHooks(options: ProcessJobOptions): JobHooks {
  const limit = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  let buffer = Buffer.alloc(0);
  let truncated = false;
  let cancelled = false;
  let settled = false;
  let child: ChildProcess | undefined;

  const append = (chunk: Buffer): void => {
    if (settled) return;
    if (options.onOutput !== undefined && chunk.byteLength > 0) {
      options.onOutput(chunk.toString("utf8"));
    }
    const next = Buffer.concat([buffer, chunk]);
    if (next.byteLength <= limit) {
      buffer = next;
      return;
    }
    truncated = true;
    buffer = next.subarray(next.byteLength - limit);
  };

  let resolveDone!: (outcome: JobOutcome) => void;
  const done = new Promise<JobOutcome>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (outcome: JobOutcome): void => {
    if (settled) return;
    settled = true;
    resolveDone(outcome);
  };

  // Jobs are the place where orphaned grandchildren hurt most: a
  // backgrounded child inherits our pipes, so killing only the shell
  // leaves the job permanently "running". `detached` gives the job its
  // own process group so the ladder can take the whole tree.
  const detached = process.platform !== "win32";
  child = spawn("sh", ["-c", options.command], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const identity = captureChildIdentity(child);

  child.stdout?.on("data", (c: Buffer) => append(c));
  child.stderr?.on("data", (c: Buffer) => append(c));

  child.on("error", (err) => {
    finish({
      status: "failed",
      detail: err.message,
      output: buffer.toString("utf8"),
    });
  });

  child.on("close", (code, signal) => {
    const text =
      buffer.toString("utf8") + (truncated ? "\n…[truncated]" : "");
    if (cancelled) {
      finish({
        status: "killed",
        detail: signal !== null ? `signal ${signal}` : `exit ${code ?? "?"}`,
        output: text,
      });
      return;
    }
    if (code === 0) {
      finish({ status: "completed", detail: "exit 0", output: text });
      return;
    }
    finish({
      status: "failed",
      detail:
        signal !== null ? `signal ${signal}` : `exit ${code ?? "?"}`,
      output: text,
    });
  });

  return {
    cancel(reason?: string): void {
      if (settled || cancelled) return;
      cancelled = true;
      const target = child;
      if (target === undefined || target.killed) return;
      // SIGTERM → grace → SIGKILL against the job's process group, with a
      // PID-reuse fence and a bounded wait for the pipes. The `close`
      // handler normally reports `killed`; `onForceClose` is the backstop
      // for a descendant that escaped the group (`setsid`, double-fork).
      void reapChild(target, {
        graceMs,
        processGroup: detached,
        ...(identity !== undefined ? { identity } : {}),
        onForceClose: () => {
          finish({
            status: "killed",
            detail: reason ?? "SIGKILL",
            output: buffer.toString("utf8"),
          });
        },
      });
    },
    done,
    readOutput(): string {
      const text = buffer.toString("utf8");
      buffer = Buffer.alloc(0);
      return text + (truncated ? "\n…[truncated]" : "");
    },
  };
}
