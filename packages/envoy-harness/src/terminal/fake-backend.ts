/**
 * Phase C / Item 9 — hermetic fake terminal backend.
 *
 * Line-buffered scrollback with immediate send settlement.
 * No real PTY / `node-pty`. Controllable hooks for tests.
 */

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

/** Optional hooks / knobs for {@link createFakeTerminalBackend}. */
export interface FakeTerminalBackendOptions {
  /** Backend type key (default `"fake"`). */
  type?: string;
  /** MOTD returned on spawn (default `"fake terminal ready"`). */
  motd?: string;
  /** Optional process id exposed on snapshots. */
  pid?: number;
  /** Delay before a send settles (default `0`). */
  sendDelayMs?: number;
  onSpawn?: (spec: TerminalBackendSpawnSpec) => void | Promise<void>;
  onSend?: (request: TerminalSendRequest, sessionId: string) => void;
  onSignal?: (signal: TerminalSignal, sessionId: string) => void;
  onClose?: (reason: string, sessionId: string) => void;
}

/** Mutable state exposed for tests via {@link createFakeTerminalBackend}. */
export interface FakeTerminalSessionState {
  lines: string[];
  status: TerminalSessionStatus;
  signals: TerminalSignal[];
  closed: string[];
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
    // Newest-first page that did not reach the oldest line.
    truncated: startFromEnd === 0 && endFromEnd < totalLines,
  };
}

function createFakeSession(
  sessionId: string,
  options: FakeTerminalBackendOptions,
  state: FakeTerminalSessionState,
): TerminalBackendSession {
  const motd = options.motd ?? "fake terminal ready";
  const pid = options.pid;
  const sendDelayMs = options.sendDelayMs ?? 0;

  const session: TerminalBackendSession = {
    motd,
    ...(pid !== undefined ? { pid } : {}),
    startSend(request: TerminalSendRequest): TerminalSendOperation {
      options.onSend?.(request, sessionId);
      const chunk =
        request.submit === true ? `${request.text}\n` : request.text;
      appendToLines(state.lines, chunk);
      const viewport = chunk;
      let settled = false;
      let settle!: () => void;
      const gate = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const timer =
        sendDelayMs > 0
          ? setTimeout(() => {
              if (!settled) {
                settled = true;
                settle();
              }
            }, sendDelayMs)
          : undefined;
      if (sendDelayMs <= 0) {
        queueMicrotask(() => {
          if (!settled) {
            settled = true;
            settle();
          }
        });
      }

      const done = gate.then(() => {
        if (timer !== undefined) clearTimeout(timer);
        return {
          viewport,
          waitReason: "inferred_idle" as const,
          sessionStatus: state.status,
          truncated: false,
        };
      });

      return {
        done,
        readOutput() {
          return { delta: viewport, truncated: false };
        },
        cancel() {
          if (settled) return false;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          settle();
          return true;
        },
      };
    },

    read(request: TerminalReadRequest): TerminalReadResult {
      return pageLines(state.lines, request);
    },

    async signal(signal: TerminalSignal) {
      options.onSignal?.(signal, sessionId);
      state.signals.push(signal);
      if (signal === "SIGKILL" && state.status.kind === "running") {
        state.status = { kind: "exited", exitCode: null, signal: "SIGKILL" };
      }
      return { delivered: true as const, targetPgid: pid ?? 1 };
    },

    status() {
      return state.status;
    },

    async close(reason: string) {
      options.onClose?.(reason, sessionId);
      state.closed.push(reason);
      if (state.status.kind === "running") {
        state.status = { kind: "exited", exitCode: 0, signal: null };
      }
    },
  };

  return session;
}

/**
 * Create a fake {@link TerminalBackend} for hermetic tests.
 * Sessions retain a line buffer; sends settle immediately with
 * `waitReason: "inferred_idle"`.
 */
export function createFakeTerminalBackend(
  options: FakeTerminalBackendOptions = {},
): TerminalBackend & {
  /** Test helper: inspect live session buffers. */
  readonly sessions: ReadonlyMap<string, FakeTerminalSessionState>;
} {
  const type = options.type ?? "fake";
  const sessions = new Map<string, FakeTerminalSessionState>();

  return {
    type,
    sessions,
    async spawn(spec: TerminalBackendSpawnSpec) {
      spec.signal?.throwIfAborted();
      await options.onSpawn?.(spec);
      spec.signal?.throwIfAborted();
      const state: FakeTerminalSessionState = {
        lines: [],
        status: { kind: "running" },
        signals: [],
        closed: [],
      };
      sessions.set(spec.sessionId, state);
      return createFakeSession(spec.sessionId, options, state);
    },
  };
}
