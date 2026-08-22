/**
 * Phase E — ProtocolSessionBackend backed by Agent.run().
 */

import type { Agent, AgentResult } from "../agent.js";
import { HookRegistry } from "../hooks/index.js";
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
  /** Cap live sessions; oldest are dropped. Default 32. */
  maxSessions?: number;
}

interface LiveSession {
  agent: Agent;
  abort: AbortController | undefined;
  /** Resolves pending host permission waits so cancel can unblock. */
  permissionWait:
    | {
        resolve: (decision: "allow" | "deny") => void;
      }
    | undefined;
  requestPermission:
    | ((req: {
        sessionId: string;
        toolName: string;
        description: string;
        args: unknown;
      }) => Promise<"allow" | "deny">)
    | undefined;
  createdAt: number;
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

function abortAsDeny(signal: AbortSignal): Promise<"deny"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("deny");
      return;
    }
    signal.addEventListener("abort", () => resolve("deny"), { once: true });
  });
}

export function createAgentSessionBackend(
  options: AgentSessionBackendOptions,
): ProtocolSessionBackend {
  const sessions = new Map<string, LiveSession>();
  const maxSessions = options.maxSessions ?? 32;

  const pruneIfNeeded = (): void => {
    while (sessions.size >= maxSessions) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, live] of sessions) {
        if (live.createdAt < oldestAt) {
          oldestAt = live.createdAt;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      const doomed = sessions.get(oldestId);
      sessions.delete(oldestId);
      doomed?.abort?.abort();
      doomed?.permissionWait?.resolve("deny");
      doomed?.agent.abort("session evicted");
    }
  };

  return {
    async createSession(params) {
      pruneIfNeeded();
      const sessionId = newSessionId();
      const cwd = params?.cwd ?? options.defaultCwd;
      const live: LiveSession = {
        agent: undefined as unknown as Agent,
        abort: undefined,
        permissionWait: undefined,
        requestPermission: undefined,
        createdAt: Date.now(),
      };
      const askHandler: AskHandler = async (req) => {
        if (req.signal.aborted) {
          return { kind: "deny", reason: "cancelled" };
        }
        const hostAsk =
          live.requestPermission?.({
            sessionId,
            toolName: req.tool,
            description: req.question,
            args: req.args,
          }) ?? Promise.resolve<"deny">("deny");

        const wrappedHost = new Promise<"allow" | "deny">((resolve) => {
          live.permissionWait = { resolve };
          void hostAsk.then(
            (d) => {
              live.permissionWait = undefined;
              resolve(d);
            },
            () => {
              live.permissionWait = undefined;
              resolve("deny");
            },
          );
        });

        const decision = await Promise.race([
          wrappedHost,
          abortAsDeny(req.signal),
        ]);
        live.permissionWait = undefined;
        if (req.signal.aborted || decision !== "allow") {
          return {
            kind: "deny",
            reason: req.signal.aborted ? "cancelled" : "host denied",
          };
        }
        return { kind: "allow" };
      };
      live.agent = options.createAgent({ sessionId, cwd, askHandler });
      // Prefer a private registry so PreToolUse asks don't stack on the
      // process-wide defaultRegistry when createAgent omits hooks.
      const hooks = live.agent.hooks ?? new HookRegistry();
      installToolPermissionAskHook(hooks, {
        ...(options.shouldAskTool !== undefined
          ? { shouldAsk: options.shouldAskTool }
          : {}),
      });
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
        live.permissionWait?.resolve("deny");
        live.permissionWait = undefined;
        // Agent.run() polls abortController; cancel must abort the Agent,
        // not only a local controller that nothing observes.
        live.agent.abort("session cancelled");
      };
      params.signal.addEventListener("abort", onAbort, { once: true });
      // Only return / notify messages produced by this turn.
      // Prefer getMessageCount() so hermetic mocks need not expose session.
      const priorCount =
        typeof live.agent.getMessageCount === "function"
          ? live.agent.getMessageCount()
          : (live.agent.session?.messages.length ?? 0);
      try {
        const result: AgentResult = await live.agent.run(params.text);
        const turnMessages = result.messages.slice(priorCount);
        const messages: ProtocolCommittedMessage[] = [];
        for (const m of turnMessages) {
          const text = messageText(m.content);
          if (text.length === 0) continue;
          const role = m.role as ProtocolCommittedMessage["role"];
          const msg: ProtocolCommittedMessage = { role, text };
          messages.push(msg);
          params.onUpdate?.(msg);
        }
        const stopReason = params.signal.aborted
          ? "cancelled"
          : result.stopReason;
        return { stopReason, messages };
      } finally {
        params.signal.removeEventListener("abort", onAbort);
        live.abort = undefined;
        live.permissionWait = undefined;
        live.requestPermission = undefined;
      }
    },

    cancel(sessionId) {
      const live = sessions.get(sessionId);
      if (live === undefined) return;
      live.abort?.abort();
      live.permissionWait?.resolve("deny");
      live.permissionWait = undefined;
      live.agent.abort("session cancelled");
    },
  };
}
