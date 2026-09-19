/**
 * Shared spawn-and-capture helper for all sandbox executors
 * (landlock, seatbelt, noop, windows-job).
 *
 * **Why this exists:** the backends each had near-identical
 * `spawn → pipe stdout/stderr → resolve on close` boilerplate.
 * This helper:
 *
 * 1. Spawns the child with `stdio: ["ignore", "pipe", "pipe"]` and, on
 *    POSIX, `detached: true` so it leads its own process group.
 * 2. Streams stdout and stderr separately, each capped at
 *    `maxOutputBytes` (default 1 MiB per stream).
 * 3. Resolves on `close` with captured text + truncation flags,
 *    OR on `error` (spawn failure). A **signal** death also resolves —
 *    `code` is `null` there, which is why the settle predicate is the
 *    `close` event rather than the exit code.
 * 4. Honors `AbortSignal` via `spawn({ signal })` **and**
 *    {@link reapChild}: a TERM→KILL ladder against the whole
 *    process group plus a PID-reuse fence and a bounded pipe teardown.
 *    Node's spawn signal alone kills only the direct child, and a
 *    backgrounded grandchild holding the stdout pipe would otherwise
 *    keep this promise pending forever.
 *
 * Do NOT introduce another copy of this in a backend.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { captureChildIdentity, reapChild } from "../../process/reaper.js";
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
    // `detached` gives the child its own process group so the kill ladder
    // can address the whole tree with `-pid`. Without it, `-pid` would
    // name the AGENT's group and killing it would take down the harness.
    const detached = process.platform !== "win32";
    try {
      child = spawn(options.file, [...options.args], {
        cwd: options.cwd,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        detached,
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
    // Captured while the child is definitely alive, so a later kill
    // cannot hit a recycled pid.
    const identity = captureChildIdentity(child);

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outTotal = 0;
    let errTotal = 0;
    let outTruncated = false;
    let errTruncated = false;
    let outClosed = false;
    let errClosed = false;
    let childExitCode: number | null = null;
    let childSignal: string | null = null;
    // `closed` — NOT `childExitCode !== null` — is the settle predicate.
    // A signal-killed child reports `code === null`, so keying off the
    // code left the promise permanently pending (`SIGSYS` under a seccomp
    // sandbox, `SIGKILL` from our own ladder, an OOM kill).
    let closed = false;
    let settled = false;

    function cleanupAbort(): void {
      options.signal?.removeEventListener("abort", onAbort);
    }

    function settle(exitCode: number, signal: string | null): void {
      if (settled) return;
      settled = true;
      cleanupAbort();
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode,
        signal,
        isError: exitCode !== 0 || signal !== null,
        stdoutTruncated: outTruncated,
        stderrTruncated: errTruncated,
      });
    }

    /**
     * Last-resort settlement when the pipes had to be torn down.
     *
     * Deliberately NOT exit 125: that code means "the sandbox launcher
     * failed, the command never ran", and {@link classifySandboxFailure}
     * reports it as infrastructure. Here the command *did* run and a
     * descendant outlived the kill ladder, so an unwitnessed death is
     * reported the conventional way — 137, killed by SIGKILL.
     */
    function finishAfterForcedClose(): void {
      const exitCode = childExitCode ?? 137;
      settle(exitCode, childSignal ?? (childExitCode === null ? "SIGKILL" : null));
    }

    function tryFinish(): void {
      if (settled) return;
      // Wait for the child to actually close AND for both pipes to close
      // (so we don't truncate trailing output).
      if (!closed) return;
      if (!outClosed || !errClosed) return;
      settle(childExitCode ?? 1, childSignal);
    }

    function onAbort(): void {
      void reapChild(child, {
        processGroup: detached,
        ...(identity !== undefined ? { identity } : {}),
        onForceClose: () => {
          finishAfterForcedClose();
        },
      });
    }
    // Registered after the settle helpers so a synchronously-aborted
    // signal is safe to handle.
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

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

    child.on("close", (code, signal) => {
      // Node sets `child.exitCode` synchronously here. `code` is null when
      // the child died from a signal — which is exactly why the settle
      // predicate is `closed`, not `code !== null`.
      childExitCode = code;
      childSignal = signal;
      closed = true;
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
        signal: null,
        isError: true,
        stdoutTruncated: outTruncated,
        stderrTruncated: errTruncated,
      });
    });
  });
}
