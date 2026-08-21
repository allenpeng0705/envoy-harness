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
      handle.write(chunk);
      const viewport = chunk;
      const done = Promise.resolve({
        viewport,
        waitReason: "inferred_idle" as const,
        sessionStatus: getStatus(),
        truncated: false,
      });
      return {
        done,
        readOutput() {
          return { delta: viewport, truncated: false };
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
          signal:
            signal !== undefined
              ? ((`SIG${signal}` as unknown as NodeJS.Signals) ?? null)
              : null,
        };
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
