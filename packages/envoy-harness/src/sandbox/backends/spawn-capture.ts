/**
 * Shared spawn-and-capture helper for all sandbox executors
 * (landlock, seatbelt, noop, windows-job).
 *
 * **Why this exists:** the backends each had near-identical
 * `spawn → pipe stdout/stderr → resolve on close` boilerplate.
 * This helper:
 *
 * 1. Spawns the child with `stdio: ["ignore", "pipe", "pipe"]`.
 * 2. Streams stdout and stderr separately, each capped at
 *    `maxOutputBytes` (default 1 MiB per stream).
 * 3. Resolves on `close` with captured text + truncation flags,
 *    OR on `error` (spawn failure).
 * 4. Honors `AbortSignal` via `spawn({ signal })` **and**
 *    {@link killProcessTree} (R6.2). Node's spawn signal alone
 *    kills only the direct child on Windows; nested `cmd.exe`
 *    grandchildren can survive without a tree kill.
 *
 * Do NOT introduce another copy of this in a backend.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { killProcessTree } from "../../process/kill-tree.js";
import type { SandboxResult } from "../types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB per stream

export interface SpawnCaptureOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  signal: AbortSignal | undefined;
  /** Per-stream cap. Default 1 MiB. */
  maxOutputBytes?: number;
  /** Live stdout chunks (UTF-8). Used for protocol `tool_progress`. */
  onStdout?: (chunk: string) => void;
}

export interface SpawnCaptureResult extends SandboxResult {
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export function spawnCapture(options: SpawnCaptureOptions): Promise<SpawnCaptureResult> {
  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.file, [...options.args], {
        cwd: options.cwd,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        isError: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      return;
    }

    const onAbort = (): void => {
      killProcessTree(child.pid);
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outTotal = 0;
    let errTotal = 0;
    let outTruncated = false;
    let errTruncated = false;
    let outClosed = false;
    let errClosed = false;
    let childExitCode: number | null = null;
    let settled = false;

    const cleanupAbort = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    const tryFinish = (): void => {
      if (settled) return;
      // Wait for the child to actually close (so `exitCode`
      // is set) AND for both pipes to close (so we don't
      // truncate trailing output).
      if (childExitCode === null) return;
      if (!outClosed || !errClosed) return;
      settled = true;
      cleanupAbort();
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      resolve({
        stdout,
        stderr,
        exitCode: childExitCode,
        isError: childExitCode !== 0,
        stdoutTruncated: outTruncated,
        stderrTruncated: errTruncated,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (options.onStdout !== undefined && chunk.byteLength > 0) {
        options.onStdout(chunk.toString("utf8"));
      }
      if (outTruncated) return; // drain but drop
      const remaining = cap - outTotal;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) outChunks.push(chunk.subarray(0, remaining));
        outTotal = cap;
        outTruncated = true;
        // Switch to "drain-and-drop" mode instead of destroying
        // the stream. Destroying a pipe stream can wedge the
        // child on SIGPIPE handling; keeping the pipe open and
        // letting the kernel buffer drain is safer and lets the
        // child finish naturally so `close` fires.
      } else {
        outChunks.push(chunk);
        outTotal += chunk.byteLength;
      }
    });
    child.stdout?.on("close", () => {
      outClosed = true;
      tryFinish();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (errTruncated) return;
      const remaining = cap - errTotal;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) errChunks.push(chunk.subarray(0, remaining));
        errTotal = cap;
        errTruncated = true;
        // Same "drain-and-drop" rationale as stdout.
      } else {
        errChunks.push(chunk);
        errTotal += chunk.byteLength;
      }
    });
    child.stderr?.on("close", () => {
      errClosed = true;
      tryFinish();
    });

    child.on("close", (code) => {
      // Node sets `child.exitCode` synchronously here.
      childExitCode = code;
      tryFinish();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: err.message,
        exitCode: 1,
        isError: true,
        stdoutTruncated: outTruncated,
        stderrTruncated: errTruncated,
      });
    });
  });
}
