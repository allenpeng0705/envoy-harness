/**
 * Phase E — ProtocolSessionBackend backed by Agent.run().
 */

import type { Agent, AgentResult } from "../agent.js";
import { newSessionId } from "../session.js";
import type { AskHandler } from "../types.js";
import { installToolPermissionAskHook } from "./permission-hook.js";
import type {
  ProtocolCommittedMessage,
  ProtocolSessionBackend,
} from "./session-backend.js";

export interface AgentSessionBackendOptions {
  createAgent: (opts: {
    sessionId: string;
    cwd: string | undefined;
    askHandler: AskHandler;
  }) => Agent;
  defaultCwd?: string;
  /**
   * When set, PreToolUse asks only for tools where this returns true.
   * Default: ask for every tool (ACP host decides allow/deny).
   */
  shouldAskTool?: (toolName: string) => boolean;
}

interface LiveSession {
  agent: Agent;
  abort: AbortController | undefined;
  requestPermission:
    | ((req: {
        sessionId: string;
        toolName: string;
        description: string;
        args: unknown;
      }) => Promise<"allow" | "deny">)
    | undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (
        typeof b === "object" &&
        b !== null &&
        "type" in b &&
        (b as { type: unknown }).type === "text" &&
        "text" in b &&
        typeof (b as { text: unknown }).text === "string"
      ) {
        return (b as { text: string }).text;
      }
      return "";
    })
    .join("");
}

export function createAgentSessionBackend(
  options: AgentSessionBackendOptions,
): ProtocolSessionBackend {
  const sessions = new Map<string, LiveSession>();

  return {
    async createSession(params) {
      const sessionId = newSessionId();
      const cwd = params?.cwd ?? options.defaultCwd;
      const live: LiveSession = {
        agent: undefined as unknown as Agent,
        abort: undefined,
        requestPermission: undefined,
      };
      const askHandler: AskHandler = async (req) => {
        const decision = await live.requestPermission?.({
          sessionId,
          toolName: req.tool,
          description: req.question,
          args: req.args,
        });
        if (decision === "allow") return { kind: "allow" };
        return {
          kind: "deny",
          reason: decision === "deny" ? "host denied" : "no permission bridge",
        };
      };
      live.agent = options.createAgent({ sessionId, cwd, askHandler });
      // Ensure PreToolUse returns `ask` so askHandler → requestPermission runs.
      if (live.agent.hooks !== undefined) {
        installToolPermissionAskHook(live.agent.hooks, {
          ...(options.shouldAskTool !== undefined
            ? { shouldAsk: options.shouldAskTool }
            : {}),
        });
      }
      sessions.set(sessionId, live);
      return { sessionId };
    },

    async prompt(params) {
      const live = sessions.get(params.sessionId);
      if (live === undefined) {
        throw new Error(`unknown session: ${params.sessionId}`);
      }
      live.requestPermission = params.requestPermission;
      const ac = new AbortController();
      live.abort = ac;
      const onAbort = (): void => {
        ac.abort();
        // Agent.run() polls abortController; cancel must abort the Agent,
        // not only a local controller that nothing observes.
        live.agent.abort("session cancelled");
      };
      params.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result: AgentResult = await live.agent.run(params.text);
        const messages: ProtocolCommittedMessage[] = [];
        for (const m of result.messages) {
          const text = messageText(m.content);
          if (text.length === 0) continue;
          const role = m.role as ProtocolCommittedMessage["role"];
          const msg: ProtocolCommittedMessage = { role, text };
          messages.push(msg);
          params.onUpdate?.(msg);
        }
        return { stopReason: result.stopReason, messages };
      } finally {
        params.signal.removeEventListener("abort", onAbort);
        live.abort = undefined;
        live.requestPermission = undefined;
      }
    },

    cancel(sessionId) {
      const live = sessions.get(sessionId);
      if (live === undefined) return;
      live.abort?.abort();
      live.agent.abort("session cancelled");
    },
  };
}
