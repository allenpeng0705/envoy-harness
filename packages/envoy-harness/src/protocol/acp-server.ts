/**
 * Phase E / Item 10 — ACP server dialect.
 */

import type { JsonRpcConnection } from "./connection.js";
import type { ProtocolSessionBackend } from "./session-backend.js";
import { JsonRpcError, JsonRpcErrorCode } from "./types.js";
import {
  requestHostPermission,
  requestHostUserQuestion,
} from "./host-request.js";
import {
  assertInitialized,
  parseConnectPeerInput,
  parseGitDiffParams,
  parsePromptParams,
  parseRouteInput,
  parseSessionCompactParams,
  parseSessionMemoryParams,
  parseSessionPlanParams,
  parseSessionReviewParams,
  parseSessionSetModeParams,
  parseSetModelParams,
  parseSetPolicyParams,
  readOptionalCwd,
  readSessionId,
} from "./acp-params.js";

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
            loadSession: true,
            promptCapabilities: {
              image: true,
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

      case "session/load": {
        assertInitialized(initialized);
        if (backend.loadSession === undefined) {
          throw new JsonRpcError(
            "session/load not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const sessionId = readSessionId(params);
        const cwd = readOptionalCwd(params);
        const loaded = await backend.loadSession({
          sessionId,
          ...(cwd !== undefined ? { cwd } : {}),
        });
        sessions.set(loaded.sessionId, { busy: false, abort: undefined });
        return { sessionId: loaded.sessionId };
      }

      case "sessions/list": {
        assertInitialized(initialized);
        if (backend.listSessions === undefined) {
          throw new JsonRpcError(
            "sessions/list not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const sessions = await backend.listSessions();
        return { sessions };
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
            prompt: p.prompt,
            signal: ac.signal,
            requestPermission: (req) => requestHostPermission(connection, req),
            requestUserQuestion: (req) =>
              requestHostUserQuestion(connection, req),
            onUpdate: (msg) => {
              connection.notify("session/update", {
                sessionId: p.sessionId,
                message: msg,
              });
            },
            onActivity: (activity) => {
              connection.notify("session/activity", {
                sessionId: p.sessionId,
                activity,
              });
            },
            onToken: (token) => {
              connection.notify("session/token", {
                sessionId: p.sessionId,
                token,
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

      case "cluster/connect": {
        assertInitialized(initialized);
        if (backend.connectPeer === undefined) {
          throw new JsonRpcError(
            "cluster/connect not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const input = parseConnectPeerInput(params);
        return await backend.connectPeer(input);
      }

      case "config/get": {
        assertInitialized(initialized);
        return backend.getConfig?.() ?? {};
      }

      case "tools/list": {
        assertInitialized(initialized);
        return { tools: backend.listTools?.() ?? [] };
      }

      case "session/compact": {
        assertInitialized(initialized);
        if (backend.compact === undefined) {
          throw new JsonRpcError(
            "session/compact not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const p = parseSessionCompactParams(params);
        return { result: await backend.compact(p) };
      }

      case "session/set_model": {
        assertInitialized(initialized);
        if (backend.setModel === undefined) {
          throw new JsonRpcError(
            "session/set_model not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const p = parseSetModelParams(params);
        return { result: await backend.setModel(p) };
      }

      case "session/set_policy": {
        assertInitialized(initialized);
        if (backend.setPolicy === undefined) {
          throw new JsonRpcError(
            "session/set_policy not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const p = parseSetPolicyParams(params);
        return { result: await backend.setPolicy(p) };
      }

      case "session/get_policy": {
        assertInitialized(initialized);
        if (backend.getPolicy === undefined) {
          throw new JsonRpcError(
            "session/get_policy not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const sessionId = readSessionId(params);
        return { result: await backend.getPolicy({ sessionId }) };
      }

      case "git/diff": {
        assertInitialized(initialized);
        if (backend.gitDiff === undefined) {
          throw new JsonRpcError(
            "git/diff not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const p = parseGitDiffParams(params);
        return await backend.gitDiff(p);
      }

      case "git/status": {
        assertInitialized(initialized);
        if (backend.gitStatus === undefined) {
          throw new JsonRpcError(
            "git/status not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const sessionId = readSessionId(params);
        return await backend.gitStatus({ sessionId });
      }

      case "session/context": {
        assertInitialized(initialized);
        if (backend.getSessionContext === undefined) {
          throw new JsonRpcError(
            "session/context not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        return await backend.getSessionContext({
          sessionId: readSessionId(params),
        });
      }

      case "session/outline": {
        assertInitialized(initialized);
        if (backend.getTurnOutline === undefined) {
          throw new JsonRpcError(
            "session/outline not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        return await backend.getTurnOutline({
          sessionId: readSessionId(params),
        });
      }

      case "session/hooks": {
        assertInitialized(initialized);
        if (backend.listSessionHooks === undefined) {
          throw new JsonRpcError(
            "session/hooks not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const res = await backend.listSessionHooks({
          sessionId: readSessionId(params),
        });
        return res;
      }

      case "session/mcp": {
        assertInitialized(initialized);
        if (backend.listSessionMcp === undefined) {
          throw new JsonRpcError(
            "session/mcp not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        return await backend.listSessionMcp({
          sessionId: readSessionId(params),
        });
      }

      case "session/agents": {
        assertInitialized(initialized);
        if (backend.listSessionAgents === undefined) {
          throw new JsonRpcError(
            "session/agents not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        return await backend.listSessionAgents({
          sessionId: readSessionId(params),
        });
      }

      case "session/plan": {
        assertInitialized(initialized);
        if (backend.sessionPlan === undefined) {
          throw new JsonRpcError(
            "session/plan not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        return await backend.sessionPlan(parseSessionPlanParams(params));
      }

      case "session/set_mode": {
        assertInitialized(initialized);
        if (backend.setCollaborationMode === undefined) {
          throw new JsonRpcError(
            "session/set_mode not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        return await backend.setCollaborationMode(
          parseSessionSetModeParams(params),
        );
      }

      case "session/memory": {
        assertInitialized(initialized);
        if (backend.sessionMemory === undefined) {
          throw new JsonRpcError(
            "session/memory not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        return await backend.sessionMemory(parseSessionMemoryParams(params));
      }

      case "session/review": {
        assertInitialized(initialized);
        if (backend.sessionReview === undefined) {
          throw new JsonRpcError(
            "session/review not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        const p = parseSessionReviewParams(params);
        return await backend.sessionReview(p);
      }

      case "session/init": {
        assertInitialized(initialized);
        if (backend.sessionInit === undefined) {
          throw new JsonRpcError(
            "session/init not supported",
            JsonRpcErrorCode.METHOD_NOT_FOUND,
          );
        }
        return await backend.sessionInit({
          sessionId: readSessionId(params),
        });
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
