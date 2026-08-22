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
  let discoveryUnsubscribe: (() => void) | undefined;
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
              // Defensive parse: the host's `onPermissionRequest`
              // may return any shape (the typed contract is
              // `Promise<"allow" | "deny">`, but a misbehaving
              // client could return null or an object without
              // `decision`). Treat anything other than a literal
              // `"allow"` as deny.
              // 5-minute ceiling for permission waits — humans
              // might walk away, but the host should still
              // answer eventually.
              const raw = await connection.request(
                "session/request_permission",
                {
                  sessionId: req.sessionId,
                  toolName: req.toolName,
                  description: req.description,
                  args: req.args,
                },
                5 * 60_000,
              );
              const decision =
                typeof raw === "object" &&
                raw !== null &&
                "decision" in raw &&
                typeof (raw as { decision: unknown }).decision === "string"
                  ? (raw as { decision: string }).decision
                  : undefined;
              return decision === "allow" ? "allow" : "deny";
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

      case "peers/list": {
        assertInitialized(initialized);
        return { peers: backend.listPeers?.() ?? [] };
      }

      case "cluster/status": {
        assertInitialized(initialized);
        return {
          cluster: (await backend.clusterStatus?.()) ?? {
            peers: [],
            connected: 0,
            failed: 0,
          },
        };
      }

      case "team/jobs": {
        assertInitialized(initialized);
        return { jobs: backend.teamJobs?.() ?? [] };
      }

      case "scoreboard/summary": {
        assertInitialized(initialized);
        return { entries: backend.scoreboardSummary?.() ?? [] };
      }

      case "discovery/subscribe": {
        assertInitialized(initialized);
        if (backend.subscribeDiscovery === undefined) {
          return { subscribed: false };
        }
        discoveryUnsubscribe?.();
        const unsub = backend.subscribeDiscovery((event) => {
          connection.notify("discovery/event", { event });
        });
        discoveryUnsubscribe =
          typeof unsub === "function" ? unsub : undefined;
        return { subscribed: true };
      }

      case "cluster/route": {
        assertInitialized(initialized);
        const input = parseRouteInput(params);
        return {
          peer: backend.routePeer?.(input) ?? null,
        };
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
    discoveryUnsubscribe?.();
    discoveryUnsubscribe = undefined;
  };
}

function parseRouteInput(params: unknown): {
  capabilityTag: string;
  preferredPeerId?: string;
} {
  if (
    params === null ||
    typeof params !== "object" ||
    typeof (params as { capabilityTag?: unknown }).capabilityTag !== "string" ||
    (params as { capabilityTag: string }).capabilityTag.length === 0
  ) {
    throw new JsonRpcError(
      "capabilityTag required",
      JsonRpcErrorCode.INVALID_PARAMS,
    );
  }
  const preferred =
    (params as { preferredPeerId?: unknown }).preferredPeerId;
  return {
    capabilityTag: (params as { capabilityTag: string }).capabilityTag,
    ...(typeof preferred === "string" ? { preferredPeerId: preferred } : {}),
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
