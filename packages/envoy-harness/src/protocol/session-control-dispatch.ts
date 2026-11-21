/**
 * The session-control surface, shared by the ACP and SDK dialects.
 *
 * **Why this is one module.** `session/agents`, the two background-child
 * controls, and the three project-registry methods are dispatch lines that
 * were copy-pasted into both servers. Two copies of a wire contract drift:
 * a fix to one dialect silently leaves the other wrong, and the tests only
 * cover whichever one they happen to exercise. The dialects differ in
 * framing and in whether `initialize` is required — not in what these
 * methods do — so the behaviour lives here and each server calls in.
 *
 * ACP must call this *after* its own `assertInitialized`; the SDK has no
 * such gate (see the call sites).
 */

import type { ProtocolSessionBackend } from "./session-backend.js";
import { JsonRpcError, JsonRpcErrorCode } from "./types.js";
import {
  parseSessionAgentInterruptParams,
  parseSessionAgentMessageParams,
  parseTerminalIdParams,
  parseTerminalOpenParams,
  parseTerminalWriteParams,
  parseWorkspaceAddParams,
  parseWorkspaceAttachParams,
  parseWorkspaceFsListParams,
  parseWorkspaceFsReadParams,
  parseWorkspaceRemoveParams,
  readSessionId,
} from "./acp-params.js";

/** The methods this module owns. */
export const SESSION_CONTROL_METHODS: ReadonlySet<string> = new Set([
  "session/agents",
  "session/agent_message",
  "session/agent_interrupt",
  "workspace/list",
  "workspace/add",
  "workspace/remove",
  "workspace/fs/list",
  "workspace/fs/read",
  "workspace/attach",
  "session/terminal/open",
  "session/terminal/write",
  "session/terminal/read",
  "session/terminal/list",
  "session/terminal/close",
]);

export function isSessionControlMethod(method: string): boolean {
  return SESSION_CONTROL_METHODS.has(method);
}

function unsupported(method: string): JsonRpcError {
  return new JsonRpcError(
    `${method} not supported`,
    JsonRpcErrorCode.METHOD_NOT_FOUND,
  );
}

/**
 * Dispatch one of {@link SESSION_CONTROL_METHODS}.
 *
 * Callers should gate on {@link isSessionControlMethod} first; an unknown
 * method here throws METHOD_NOT_FOUND, same as before the extraction.
 */
export async function dispatchSessionControl(
  backend: ProtocolSessionBackend,
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case "session/agents": {
      if (backend.listSessionAgents === undefined) throw unsupported(method);
      return await backend.listSessionAgents({
        sessionId: readSessionId(params),
      });
    }
    // A settled child comes back as a structured `error`, not a JSON-RPC
    // failure: losing that race is normal, not exceptional.
    case "session/agent_message": {
      if (backend.sendAgentMessage === undefined) throw unsupported(method);
      return await backend.sendAgentMessage(
        parseSessionAgentMessageParams(params),
      );
    }
    case "session/agent_interrupt": {
      if (backend.interruptAgent === undefined) throw unsupported(method);
      return await backend.interruptAgent(
        parseSessionAgentInterruptParams(params),
      );
    }
    // A host that wired no registry reports METHOD_NOT_FOUND rather than an
    // empty list that looks like "you have no projects".
    case "workspace/list": {
      if (backend.listWorkspaces === undefined) throw unsupported(method);
      return await backend.listWorkspaces();
    }
    case "workspace/add": {
      if (backend.addWorkspace === undefined) throw unsupported(method);
      return await backend.addWorkspace(parseWorkspaceAddParams(params));
    }
    case "workspace/remove": {
      if (backend.removeWorkspace === undefined) throw unsupported(method);
      return await backend.removeWorkspace(parseWorkspaceRemoveParams(params));
    }
    case "workspace/fs/list": {
      if (backend.listWorkspaceFs === undefined) throw unsupported(method);
      return await backend.listWorkspaceFs(parseWorkspaceFsListParams(params));
    }
    case "workspace/fs/read": {
      if (backend.readWorkspaceFs === undefined) throw unsupported(method);
      return await backend.readWorkspaceFs(parseWorkspaceFsReadParams(params));
    }
    case "workspace/attach": {
      if (backend.attachWorkspaceFile === undefined) throw unsupported(method);
      return await backend.attachWorkspaceFile(
        parseWorkspaceAttachParams(params),
      );
    }
    case "session/terminal/open": {
      if (backend.openTerminal === undefined) throw unsupported(method);
      return await backend.openTerminal(parseTerminalOpenParams(params));
    }
    case "session/terminal/write": {
      if (backend.writeTerminal === undefined) throw unsupported(method);
      return await backend.writeTerminal(parseTerminalWriteParams(params));
    }
    case "session/terminal/read": {
      if (backend.readTerminal === undefined) throw unsupported(method);
      return await backend.readTerminal(parseTerminalIdParams(params));
    }
    case "session/terminal/list": {
      if (backend.listTerminals === undefined) throw unsupported(method);
      return await backend.listTerminals({
        sessionId: readSessionId(params),
      });
    }
    case "session/terminal/close": {
      if (backend.closeTerminal === undefined) throw unsupported(method);
      const p = parseTerminalIdParams(params);
      return await backend.closeTerminal({
        sessionId: p.sessionId,
        terminalId: p.terminalId,
      });
    }
    default:
      throw unsupported(method);
  }
}
