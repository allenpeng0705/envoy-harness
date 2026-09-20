/**
 * Pure request shaping + thin RPC wrappers for the project registry and
 * background-child steering added to the ACP host.
 *
 * Kept out of `host.ts` so that file stays under the module-size cap and
 * the request shapes can be unit-tested without a live WebSocket.
 */

import {
  type AgentInterruptResult,
  type AgentMessageResult,
  type WorkspaceEntry,
} from "./host-types.js";
import type { WsJsonRpcClient } from "./ws-jsonrpc.js";

/** JSON-RPC params for `session/new`; `cwd` omitted unless non-empty. */
export function sessionNewParams(cwd?: string): { cwd?: string } {
  const trimmed = cwd?.trim() ?? "";
  return trimmed !== "" ? { cwd: trimmed } : {};
}

/** JSON-RPC params for `workspace/add`; `name` omitted unless non-empty. */
export function workspaceAddParams(
  path: string,
  name?: string,
): { path: string; name?: string } {
  const trimmed = name?.trim() ?? "";
  return trimmed !== "" ? { path, name: trimmed } : { path };
}

/** JSON-RPC params for `session/agent_message`. */
export function agentMessageParams(
  sessionId: string,
  agentId: string,
  message: string,
): { sessionId: string; agentId: string; message: string } {
  return { sessionId, agentId, message };
}

/** JSON-RPC params for `session/agent_interrupt`; `reason` omitted if empty. */
export function agentInterruptParams(
  sessionId: string,
  agentId: string,
  reason?: string,
): { sessionId: string; agentId: string; reason?: string } {
  const trimmed = reason?.trim() ?? "";
  return trimmed !== ""
    ? { sessionId, agentId, reason: trimmed }
    : { sessionId, agentId };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function requestWorkspaces(
  client: WsJsonRpcClient | undefined,
): Promise<WorkspaceEntry[]> {
  if (!client || client.closed) return [];
  const res = (await client.request("workspace/list", {})) as {
    workspaces?: WorkspaceEntry[];
  };
  return res.workspaces ?? [];
}

export async function requestAddWorkspace(
  client: WsJsonRpcClient | undefined,
  path: string,
  name?: string,
): Promise<WorkspaceEntry> {
  if (!client || client.closed) throw new Error("not connected");
  const res = (await client.request(
    "workspace/add",
    workspaceAddParams(path, name),
  )) as { workspace: WorkspaceEntry };
  return res.workspace;
}

export async function requestRemoveWorkspace(
  client: WsJsonRpcClient | undefined,
  path: string,
): Promise<boolean> {
  if (!client || client.closed) throw new Error("not connected");
  const res = (await client.request("workspace/remove", { path })) as {
    removed?: boolean;
  };
  return res.removed === true;
}

/**
 * Steering a child that already settled is a normal miss: the host answers
 * with a structured `error` rather than a JSON-RPC failure, and transport
 * errors are folded into the same shape so the UI never throws.
 */
export async function requestAgentMessage(
  client: WsJsonRpcClient | undefined,
  sessionId: string | null,
  agentId: string,
  message: string,
): Promise<AgentMessageResult> {
  if (!client || client.closed || sessionId === null) {
    return { queued: false, status: "no-session", error: "no active session" };
  }
  try {
    return (await client.request(
      "session/agent_message",
      agentMessageParams(sessionId, agentId, message),
    )) as AgentMessageResult;
  } catch (err) {
    return { queued: false, status: "error", error: messageOf(err) };
  }
}

export async function requestAgentInterrupt(
  client: WsJsonRpcClient | undefined,
  sessionId: string | null,
  agentId: string,
  reason?: string,
): Promise<AgentInterruptResult> {
  if (!client || client.closed || sessionId === null) {
    return {
      interrupted: false,
      status: "no-session",
      error: "no active session",
    };
  }
  try {
    return (await client.request(
      "session/agent_interrupt",
      agentInterruptParams(sessionId, agentId, reason),
    )) as AgentInterruptResult;
  } catch (err) {
    return { interrupted: false, status: "error", error: messageOf(err) };
  }
}
