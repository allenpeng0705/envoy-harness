/**
 * Phase E / Item 10 — ACP server dialect.
 */

import type { JsonRpcConnection } from "./connection.js";
import type { ProtocolSessionBackend } from "./session-backend.js";
import { JsonRpcError, JsonRpcErrorCode } from "./types.js";

export const ACP_PROTOCOL_VERSION = 1;

export interface AcpServerOptions {
  connection: JsonRpcConnection;
  backend: ProtocolSessionBackend;
  serverInfo?: { name: string; version: string };
}

interface SessionState {
  abort: AbortController | undefined;
  busy: boolean;
}

/** Attach ACP handlers to a JSON-RPC connection. */
export function attachAcpServer(options: AcpServerOptions): () => void {
  const { connection, backend } = options;
  const serverInfo = options.serverInfo ?? {
    name: "envoy-harness",
    version: "0.0.0",
  };
  const sessions = new Map<string, SessionState>();
  let initialized = false;

  connection.setRequestHandler(async (method, params) => {
    switch (method) {
      case "initialize":
        initialized = true;
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          serverInfo,
          capabilities: {
            loadSession: false,
            promptCapabilities: {
              image: false,
              audio: false,
              embeddedContext: false,
            },
            mcpServers: false,
          },
        };

      case "authenticate":
        return { authenticated: true };

      case "session/new": {
        assertInitialized(initialized);
        const cwd = readOptionalCwd(params);
        const { sessionId } = await backend.createSession(
          cwd !== undefined ? { cwd } : undefined,
        );
        sessions.set(sessionId, { busy: false, abort: undefined });
        return { sessionId };
      }

      case "session/prompt": {
        assertInitialized(initialized);
        const p = parsePromptParams(params);
        const state = sessions.get(p.sessionId);
        if (state === undefined) {
          throw new JsonRpcError(
            `unknown session: ${p.sessionId}`,
            JsonRpcErrorCode.SESSION_ERROR,
          );
        }
        if (state.busy) {
          throw new JsonRpcError(
            `session busy: ${p.sessionId}`,
            JsonRpcErrorCode.SESSION_ERROR,
          );
        }
        state.busy = true;
        const ac = new AbortController();
        state.abort = ac;
        try {
          return await backend.prompt({
            sessionId: p.sessionId,
            text: p.text,
            signal: ac.signal,
            requestPermission: async (req) => {
              const decision = (await connection.request(
                "session/request_permission",
                {
                  sessionId: req.sessionId,
                  toolName: req.toolName,
                  description: req.description,
                  args: req.args,
                },
              )) as { decision?: string };
              return decision.decision === "allow" ? "allow" : "deny";
            },
            onUpdate: (msg) => {
              connection.notify("session/update", {
                sessionId: p.sessionId,
                message: msg,
              });
            },
          });
        } finally {
          state.busy = false;
          state.abort = undefined;
        }
      }

      case "session/cancel": {
        assertInitialized(initialized);
        const sessionId = readSessionId(params);
        const state = sessions.get(sessionId);
        if (state === undefined) {
          throw new JsonRpcError(
            `unknown session: ${sessionId}`,
            JsonRpcErrorCode.SESSION_ERROR,
          );
        }
        backend.cancel(sessionId);
        state.abort?.abort();
        return { cancelled: true };
      }

      default:
        throw new JsonRpcError(
          `method not found: ${method}`,
          JsonRpcErrorCode.METHOD_NOT_FOUND,
        );
    }
  });

  return () => {
    for (const [, state] of sessions) state.abort?.abort();
    sessions.clear();
  };
}

function assertInitialized(initialized: boolean): void {
  if (!initialized) {
    throw new JsonRpcError(
      "server not initialized; call initialize first",
      JsonRpcErrorCode.INVALID_REQUEST,
    );
  }
}

function readOptionalCwd(params: unknown): string | undefined {
  if (
    params !== null &&
    typeof params === "object" &&
    typeof (params as { cwd?: unknown }).cwd === "string"
  ) {
    return (params as { cwd: string }).cwd;
  }
  return undefined;
}

function readSessionId(params: unknown): string {
  if (
    params !== null &&
    typeof params === "object" &&
    typeof (params as { sessionId?: unknown }).sessionId === "string"
  ) {
    return (params as { sessionId: string }).sessionId;
  }
  throw new JsonRpcError("sessionId required", JsonRpcErrorCode.INVALID_PARAMS);
}

function parsePromptParams(params: unknown): {
  sessionId: string;
  text: string;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as {
    sessionId?: unknown;
    text?: unknown;
    prompt?: unknown;
  };
  if (typeof obj.sessionId !== "string") {
    throw new JsonRpcError(
      "sessionId required",
      JsonRpcErrorCode.INVALID_PARAMS,
    );
  }
  const text =
    typeof obj.text === "string"
      ? obj.text
      : typeof obj.prompt === "string"
        ? obj.prompt
        : undefined;
  if (text === undefined) {
    throw new JsonRpcError("text required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  return { sessionId: obj.sessionId, text };
}
