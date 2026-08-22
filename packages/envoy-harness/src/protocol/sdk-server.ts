/**
 * Phase E / Item 11 — embedding SDK server dialect.
 */

import type { JsonRpcConnection } from "./connection.js";
import type { ProtocolSessionBackend } from "./session-backend.js";
import { JsonRpcError, JsonRpcErrorCode } from "./types.js";

export interface SdkServerOptions {
  connection: JsonRpcConnection;
  backend: ProtocolSessionBackend;
}

interface SessionState {
  abort: AbortController | undefined;
  busy: boolean;
}

/** Attach SDK handlers to a JSON-RPC connection. */
export function attachSdkServer(options: SdkServerOptions): () => void {
  const { connection, backend } = options;
  const sessions = new Map<string, SessionState>();
  let discoveryUnsubscribe: (() => void) | undefined;

  connection.setRequestHandler(async (method, params) => {
    switch (method) {
      case "session/create": {
        const cwd =
          params !== null &&
          typeof params === "object" &&
          typeof (params as { cwd?: unknown }).cwd === "string"
            ? (params as { cwd: string }).cwd
            : undefined;
        const { sessionId } = await backend.createSession(
          cwd !== undefined ? { cwd } : undefined,
        );
        sessions.set(sessionId, { busy: false, abort: undefined });
        return { sessionId };
      }

      case "session/prompt": {
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
              // See acp-server.ts for the rationale: defensive
              // parse the host's response; anything other than
              // a literal `"allow"` is deny. Same 5-minute
              // ceiling for permission waits.
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
              connection.notify("session/event", {
                sessionId: p.sessionId,
                type: "message",
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

      case "config/get":
        return backend.getConfig?.() ?? {};

      case "tools/list":
        return { tools: backend.listTools?.() ?? [] };

      case "peers/list":
        return { peers: backend.listPeers?.() ?? [] };

      case "cluster/status":
        return {
          cluster: (await backend.clusterStatus?.()) ?? {
            peers: [],
            connected: 0,
            failed: 0,
          },
        };

      case "team/jobs":
        return { jobs: backend.teamJobs?.() ?? [] };

      case "scoreboard/summary":
        return { entries: backend.scoreboardSummary?.() ?? [] };

      case "discovery/subscribe":
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

      case "cluster/route":
        return {
          peer: backend.routePeer?.(parseSdkRouteInput(params)) ?? null,
        };

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

function parseSdkRouteInput(params: unknown): {
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
