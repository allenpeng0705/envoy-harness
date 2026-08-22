/**
 * Phase C / Item 9 — optional `node-pty` terminal backend.
 *
 * `node-pty` is an optionalDependency. When it cannot
 * be resolved, {@link isPtyAvailable} returns false and
 * callers should fall back to the fake backend.
 */

import { createRequire } from "node:module";

import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRequest,
  TerminalSessionStatus,
  TerminalSignal,
} from "./types.js";

const DEFAULT_READ_COUNT = 500;
const DEFAULT_QUIET_MS = 100;
const DEFAULT_QUIESCENCE_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 25;
const require = createRequire(import.meta.url);

/** Minimal subset of the `node-pty` IPty surface we use. */
interface PtyHandle {
  readonly pid: number;
  write(data: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ): PtyHandle;
}

function tryResolvePty(): boolean {
  try {
    require.resolve("node-pty");
    return true;
  } catch {
    return false;
  }
}

/** True when the optional `node-pty` package can be resolved. */
export function isPtyAvailable(): boolean {
  return tryResolvePty();
}

async function loadPty(): Promise<PtyModule> {
  const mod = (await import("node-pty")) as unknown as PtyModule;
  return mod;
}

function appendToLines(lines: string[], chunk: string): void {
  if (chunk.length === 0) return;
  const parts = chunk.split("\n");
  if (lines.length === 0) lines.push("");
  lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    lines.push(parts[i]!);
  }
}

function pageLines(
  lines: string[],
  request: TerminalReadRequest,
): TerminalReadResult {
  const offset = request.offset ?? 0;
  const count = request.count ?? DEFAULT_READ_COUNT;
  const totalLines = lines.length;
  const startFromEnd = Math.min(Math.max(0, offset), totalLines);
  const endFromEnd = Math.min(startFromEnd + Math.max(0, count), totalLines);
  const sliceStart = totalLines - endFromEnd;
  const sliceEnd = totalLines - startFromEnd;
  const page = lines.slice(sliceStart, sliceEnd);
  return {
    text: page.join("\n"),
    totalLines,
    lineBegin: startFromEnd,
    lineEnd: endFromEnd,
    truncated: startFromEnd === 0 && endFromEnd < totalLines,
  };
}

/**
 * Wait for terminal output to go quiet (deepseek "readiness detection" /
 * `inferred_idle` parity). Resolves when the retained line buffer stops
 * growing for `quietMs`, the session exits, or `timeoutMs` elapses.
 * Polling-based so it is hermetic and deterministic in tests.
 */
export function waitForQuiescence(opts: {
  lines: string[];
  getStatus: () => TerminalSessionStatus;
  signal?: AbortSignal;
  quietMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<"inferred_idle" | "timeout" | "session_exit"> {
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUIESCENCE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const started = Date.now();
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve("timeout");
      return;
    }
    let last = totalChars(opts.lines);
    let lastChangedAt = started;
    const timer = setInterval(() => {
      if (opts.signal?.aborted) {
        clearInterval(timer);
        resolve("timeout");
        return;
      }
      if (opts.getStatus().kind === "exited") {
        clearInterval(timer);
        resolve("session_exit");
        return;
      }
      const now = Date.now();
      const current = totalChars(opts.lines);
      if (current !== last) {
        last = current;
        lastChangedAt = now;
      }
      if (now - lastChangedAt >= quietMs) {
        clearInterval(timer);
        resolve("inferred_idle");
        return;
      }
      if (now - started >= timeoutMs) {
        clearInterval(timer);
        resolve("timeout");
        return;
      }
    }, pollMs);
  });
}

/** Total retained characters (lines + newline separators). */
function totalChars(lines: string[]): number {
  let n = lines.length > 0 ? lines.length - 1 : 0;
  for (const line of lines) n += line.length;
  return n;
}

/** The full retained terminal text (the delta basis for send viewports). */
function retainedText(lines: string[]): string {
  return lines.join("\n");
}

function mapSignal(signal: TerminalSignal): string {
  switch (signal) {
    case "SIGINT":
      return "SIGINT";
    case "SIGTERM":
      return "SIGTERM";
    case "SIGKILL":
      return "SIGKILL";
    case "SIGTSTP":
      return "SIGTSTP";
    case "SIGHUP":
      return "SIGHUP";
  }
}

function createPtySession(
  handle: PtyHandle,
  lines: string[],
  getStatus: () => TerminalSessionStatus,
  setStatus: (s: TerminalSessionStatus) => void,
): TerminalBackendSession {
  return {
    motd: "pty ready",
    pid: handle.pid,
    startSend(request: TerminalSendRequest): TerminalSendOperation {
      const chunk =
        request.submit === true ? `${request.text}\n` : request.text;
      const before = retainedText(lines);
      let latestViewport = chunk;
      handle.write(chunk);
      const done = waitForQuiescence({
        lines,
        getStatus,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      }).then((waitReason) => {
        const after = retainedText(lines);
        const viewport =
          after.length > before.length ? after.slice(before.length) : chunk;
        latestViewport = viewport;
        return {
          viewport,
          waitReason,
          sessionStatus: getStatus(),
          truncated: false,
        };
      });
      return {
        done,
        readOutput() {
          return { delta: latestViewport, truncated: false };
        },
        cancel() {
          return false;
        },
      };
    },
    read(request: TerminalReadRequest): TerminalReadResult {
      return pageLines(lines, request);
    },
    async signal(signal: TerminalSignal) {
      handle.kill(mapSignal(signal));
      if (signal === "SIGKILL" && getStatus().kind === "running") {
        setStatus({ kind: "exited", exitCode: null, signal: "SIGKILL" });
      }
      return { delivered: true as const, targetPgid: handle.pid };
    },
    status() {
      return getStatus();
    },
    async close(_reason: string) {
      try {
        handle.kill("SIGHUP");
      } catch {
        // already exited
      }
      if (getStatus().kind === "running") {
        setStatus({ kind: "exited", exitCode: 0, signal: null });
      }
    },
  };
}

/**
 * Create a real PTY {@link TerminalBackend} via `node-pty`.
 * Callers should gate on {@link isPtyAvailable} first.
 */
export function createPtyTerminalBackend(): TerminalBackend {
  return {
    type: "pty",
    async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
      spec.signal?.throwIfAborted();
      if (!tryResolvePty()) {
        throw new Error("node-pty is not available");
      }
      const pty = await loadPty();
      spec.signal?.throwIfAborted();

      const shell =
        process.env["SHELL"] && process.env["SHELL"].length > 0
          ? process.env["SHELL"]
          : process.platform === "win32"
            ? "powershell.exe"
            : "/bin/bash";

      const handle = pty.spawn(shell, [], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        env: process.env,
      });

      const lines: string[] = [];
      let status: TerminalSessionStatus = { kind: "running" };
      handle.onData((data) => appendToLines(lines, data));
      handle.onExit(({ exitCode, signal }) => {
        status = {
          kind: "exited",
          exitCode,
          signal: null,
        };
        // node-pty reports numeric signal codes; we don't map them
        // to NodeJS.Signals names here (fake backend uses string names).
        void signal;
      });

      return createPtySession(
        handle,
        lines,
        () => status,
        (s) => {
          status = s;
        },
      );
    },
  };
}
