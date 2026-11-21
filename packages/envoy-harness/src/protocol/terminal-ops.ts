/**
 * Host-facing interactive terminal ops (Wave 3).
 * Owner = ACP session id; service is shared across sessions.
 */

import type { TerminalSessionService } from "../terminal/types.js";
import { TerminalError } from "../terminal/types.js";

export function pickTerminalBackendType(
  service: TerminalSessionService,
): string {
  const backends = service.listBackends();
  if (backends.includes("pty")) return "pty";
  if (backends.length > 0) return backends[0]!;
  throw new Error("no terminal backends registered");
}

export async function openTerminalOp(
  service: TerminalSessionService,
  owner: string,
  params: { cwd?: string; name?: string; cols?: number; rows?: number },
): Promise<{
  terminalId: string;
  type: string;
  motd: string;
  status: unknown;
}> {
  const type = pickTerminalBackendType(service);
  const snap = await service.spawn(owner, {
    type,
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
  });
  return {
    terminalId: snap.sessionId,
    type: snap.type,
    motd: snap.motd,
    status: snap.status,
  };
}

export async function writeTerminalOp(
  service: TerminalSessionService,
  owner: string,
  params: {
    terminalId: string;
    data: string;
    submit?: boolean;
    onDelta?: (delta: string) => void;
  },
): Promise<{
  viewport: string;
  waitReason: string;
  truncated: boolean;
  status: unknown;
}> {
  const op = service.startSend(owner, params.terminalId, {
    text: params.data,
    submit: params.submit !== false,
  });
  let lastLen = 0;
  const poll = setInterval(() => {
    try {
      const { delta } = op.readOutput();
      if (delta.length > lastLen) {
        const chunk = delta.slice(lastLen);
        lastLen = delta.length;
        params.onDelta?.(chunk);
      }
    } catch {
      // ignore mid-send races
    }
  }, 40);
  try {
    const result = await op.done;
    return {
      viewport: result.viewport,
      waitReason: result.waitReason,
      truncated: result.truncated,
      status: result.sessionStatus,
    };
  } finally {
    clearInterval(poll);
  }
}

export function readTerminalOp(
  service: TerminalSessionService,
  owner: string,
  params: { terminalId: string; offset?: number; count?: number },
): {
  text: string;
  totalLines: number;
  lineBegin: number;
  lineEnd: number;
  truncated: boolean;
} {
  return service.read(owner, params.terminalId, {
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
    ...(params.count !== undefined ? { count: params.count } : {}),
  });
}

export function listTerminalsOp(
  service: TerminalSessionService,
  owner: string,
): { terminals: ReturnType<TerminalSessionService["list"]> } {
  return { terminals: service.list(owner) };
}

export async function closeTerminalOp(
  service: TerminalSessionService,
  owner: string,
  params: { terminalId: string },
): Promise<{ closed: boolean }> {
  const closed = await service.kill(owner, params.terminalId, "host close");
  return { closed };
}

export function mapTerminalError(err: unknown): Error {
  if (err instanceof TerminalError) {
    return new Error(`terminal: ${err.message} (${err.code})`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
