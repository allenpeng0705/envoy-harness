/**
 * Phase E — ProtocolSessionBackend backed by Agent.run().
 */

import type { MemoryStore } from "../memories/store.js";
import type { Agent, AgentResult } from "../agent.js";
import { hasTurnHints } from "../interaction/turn-hints.js";
import { createProviderAdapter } from "../llm/index.js";
import { HookRegistry } from "../hooks/index.js";
import { newSessionId } from "../session.js";
import type { AskHandler } from "../types.js";
import type { Tracer } from "../trace/types.js";
import { traceEventToActivity } from "./activity-format.js";
import { formatGitOutput, runGitDiff, runGitStatus } from "./git-runner.js";
import { traceEventToCommittedMessage } from "./message-format.js";
import {
  formatSubagentRecords,
  runMemoryOp,
  runPlanAction,
  runSessionInit,
  runSessionReview,
  summarizeDroppedMessages,
  type PlanAction,
} from "./session-ops.js";
import { installToolPermissionAskHook } from "./permission-hook.js";
import type { Session } from "../session.js";
import { SessionStore } from "../session/session-store.js";
import {
  shouldAskUnderAutoRun,
  type AutoRunPolicy,
} from "../permissions/auto-run.js";
import type {
  ProtocolClusterStatus,
  ProtocolScoreboardEntry,
  ProtocolTeamJob,
  ProtocolPeerInfo,
  ProtocolCommittedMessage,
  ProtocolPromptInput,
  ProtocolSessionBackend,
  ProtocolToolInfo,
} from "./session-backend.js";

export interface AgentSessionBackendOptions {
  createAgent: (opts: {
    sessionId: string;
    cwd: string | undefined;
    askHandler: AskHandler;
    /** When resuming, the persisted session instance (else in-memory). */
    session?: Session;
  }) => Agent;
  /** When set, `loadSession` reads JSONL transcripts from disk. */
  sessionStore?: SessionStore;
  defaultCwd?: string;
  /**
   * When set, PreToolUse asks only for tools where this returns true.
   * Default: ask for every tool (ACP host decides allow/deny).
   */
  shouldAskTool?: (toolName: string, args?: unknown) => boolean;
  /** Cap live sessions; oldest are dropped. Default 32. */
  maxSessions?: number;
  /**
   * R3 — the host's connected peer cluster, exposed over `peers/list`
   * (ACP + SDK). Hosts with a peer registry (e.g. EnvoyMesh's in-process
   * ACP host) pass a snapshot function here.
   */
  listPeers?: () => ReadonlyArray<ProtocolPeerInfo>;
  /** U1 — cluster status (peers + health) for the dedicated UI. */
  clusterStatus?: () => ProtocolClusterStatus;
  /** U1 — team jobs (running/finished) for the dedicated UI. */
  teamJobs?: () => ReadonlyArray<ProtocolTeamJob>;
  /** U1 — peer reputation scoreboard for the dedicated UI. */
  scoreboardSummary?: () => ReadonlyArray<ProtocolScoreboardEntry>;
  /** U2 — host config for the status bar (e.g. `{ model }`). */
  getConfig?: () => Record<string, unknown>;
  /** Tool catalog for `tools/list`. */
  listTools?: () => ProtocolToolInfo[];
  /** Optional memory store for `session/memory` (REPL parity). */
  memoryStore?: MemoryStore;
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
  modelLabel?: string;
  providerLabel?: string;
  /** Session-level auto-run permission policy (TUI / ACP hosts). */
  autoRun?: AutoRunPolicy;
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
      if (
        typeof b === "object" &&
        b !== null &&
        "type" in b &&
        (b as { type: unknown }).type === "image"
      ) {
        const mime =
          "mimeType" in b && typeof (b as { mimeType: unknown }).mimeType === "string"
            ? (b as { mimeType: string }).mimeType
            : "image";
        return `[image: ${mime}]`;
      }
      return "";
    })
    .join("");
}

function promptToUserBlocks(
  prompt: ProtocolPromptInput,
): Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> {
  if ("text" in prompt) {
    return [{ type: "text", text: prompt.text }];
  }
  return [...prompt.content];
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

function assertSessionIdle(live: LiveSession): void {
  if (live.abort !== undefined) {
    throw new Error("session busy");
  }
}

const DEFAULT_COMPACT_KEEP = 20;

function truncateActivity(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length === 0) return "";
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function requireLive(
  sessions: Map<string, LiveSession>,
  sessionId: string,
): LiveSession {
  const live = sessions.get(sessionId);
  if (live === undefined) {
    throw new Error(`unknown session: ${sessionId}`);
  }
  return live;
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
      const cwd = params?.cwd ?? options.defaultCwd ?? process.cwd();
      let sessionId: string;
      let persisted:
        | import("../session/persisted-session.js").PersistedSession
        | undefined;
      if (options.sessionStore !== undefined) {
        persisted = await options.sessionStore.create({
          cwd,
          startedAt: new Date().toISOString(),
          permissionMode: "workspace-write",
        });
        sessionId = persisted.id;
      } else {
        sessionId = newSessionId();
      }
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
      live.agent = options.createAgent({
        sessionId,
        cwd,
        askHandler,
        ...(persisted !== undefined ? { session: persisted } : {}),
      });
      // process-wide defaultRegistry when createAgent omits hooks.
      const hooks = live.agent.hooks ?? new HookRegistry();
      installToolPermissionAskHook(hooks, {
        shouldAsk: (toolName, args) => {
          // Session-level auto-run policy (TUI / hosts) wins; otherwise
          // fall back to the host's shouldAskTool, then ask.
          const autoRun = shouldAskUnderAutoRun(
            live.autoRun,
            toolName,
            args,
          );
          if (autoRun !== undefined) return autoRun;
          return options.shouldAskTool?.(toolName, args) ?? true;
        },
      });
      sessions.set(sessionId, live);
      return { sessionId };
    },

    async loadSession(params) {
      if (options.sessionStore === undefined) {
        throw new Error("session store not configured");
      }
      pruneIfNeeded();
      const persisted = await options.sessionStore.load(params.sessionId);
      const sessionId = persisted.id;
      const cwd =
        params.cwd ??
        persisted.metadata.cwd ??
        options.defaultCwd;
      const doomed = sessions.get(sessionId);
      if (doomed !== undefined) {
        doomed.abort?.abort();
        doomed.permissionWait?.resolve("deny");
        doomed.agent.abort("session replaced");
        sessions.delete(sessionId);
      }
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
      live.agent = options.createAgent({
        sessionId,
        cwd,
        askHandler,
        session: persisted,
      });
      const hooks = live.agent.hooks ?? new HookRegistry();
      installToolPermissionAskHook(hooks, {
        shouldAsk: (toolName, args) => {
          const autoRun = shouldAskUnderAutoRun(
            live.autoRun,
            toolName,
            args,
          );
          if (autoRun !== undefined) return autoRun;
          return options.shouldAskTool?.(toolName, args) ?? true;
        },
      });
      sessions.set(sessionId, live);
      return { sessionId };
    },

    async listSessions() {
      if (options.sessionStore === undefined) {
        return [];
      }
      return await options.sessionStore.listSummaries();
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
        live.agent.assistantStreamSink = undefined;
        live.agent.toolOutputSink = undefined;
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
      const priorTracer = live.agent.tracer;
      const touchedFiles: string[] = [];
      const forwardTracer: Tracer = {
        emit: (event) => {
          priorTracer.emit(event);
          if (event.kind === "tool_call") {
            const args = event.call.args as Record<string, unknown>;
            if (event.call.name === "write" || event.call.name === "edit") {
              const path =
                typeof args.path === "string" && args.path.length > 0
                  ? args.path
                  : undefined;
              if (path !== undefined && !touchedFiles.includes(path)) {
                touchedFiles.push(path);
              }
            }
          }
          if (params.onActivity !== undefined) {
            const activity = traceEventToActivity(event);
            if (event.kind === "agent_end" && touchedFiles.length > 0) {
              activity.summary = `${activity.summary} · changed: ${touchedFiles.join(", ")}`;
            }
            params.onActivity(activity);
          }
          const committed = traceEventToCommittedMessage(event);
          if (committed !== undefined) {
            params.onUpdate?.(committed);
          }
        },
      };
      live.agent.tracer = forwardTracer;
      live.agent.assistantStreamSink = (delta) => {
        if (params.signal.aborted || ac.signal.aborted) return;
        params.onToken?.({ role: "assistant", delta });
      };
      live.agent.toolOutputSink = (info) => {
        if (params.signal.aborted || ac.signal.aborted) return;
        if (params.onActivity === undefined) return;
        const summary = truncateActivity(info.stdout, 120);
        if (summary.length === 0) return;
        params.onActivity({
          kind: "tool_progress",
          ts: new Date().toISOString(),
          toolName: info.toolName,
          toolCallId: info.callId,
          summary,
        });
      };
      try {
        const result: AgentResult = await live.agent.run(
          promptToUserBlocks(params.prompt),
        );
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
        return {
          stopReason,
          messages,
          ...(result.turnHints !== undefined && hasTurnHints(result.turnHints)
            ? { turnHints: result.turnHints }
            : {}),
        };
      } finally {
        live.agent.tracer = priorTracer;
        live.agent.assistantStreamSink = undefined;
        live.agent.toolOutputSink = undefined;
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

    async compact(params) {
      const live = requireLive(sessions, params.sessionId);
      assertSessionIdle(live);
      const before = live.agent.getMessageCount();
      if (params.budget !== undefined) {
        const r = live.agent.compactWithBudget(params.budget);
        const after = live.agent.getMessageCount();
        return {
          messageCountBefore: before,
          messageCountAfter: after,
          droppedCount: r.droppedCount,
          totalTokensAfter: r.totalTokensAfter,
          overBudget: r.overBudget,
        };
      }
      const keep = params.keep ?? DEFAULT_COMPACT_KEEP;
      if (params.summarize === true) {
        try {
          await live.agent.compactWithSummary(keep, (dropped) =>
            summarizeDroppedMessages(live.agent, dropped),
          );
        } catch {
          live.agent.compact(keep);
          const after = live.agent.getMessageCount();
          return {
            messageCountBefore: before,
            messageCountAfter: after,
            droppedCount: Math.max(0, before - after),
            summarized: false,
          };
        }
        const after = live.agent.getMessageCount();
        return {
          messageCountBefore: before,
          messageCountAfter: after,
          droppedCount: Math.max(0, before - after),
          summarized: true,
        };
      }
      live.agent.compact(keep);
      const after = live.agent.getMessageCount();
      return {
        messageCountBefore: before,
        messageCountAfter: after,
        droppedCount: Math.max(0, before - after),
      };
    },

    async setModel(params) {
      const live = sessions.get(params.sessionId);
      if (live === undefined) {
        throw new Error(`unknown session: ${params.sessionId}`);
      }
      assertSessionIdle(live);
      const adapter = createProviderAdapter({
        provider: params.provider,
        ...(params.model !== undefined ? { model: params.model } : {}),
      });
      live.agent.setModel(adapter);
      live.providerLabel = params.provider;
      live.modelLabel =
        params.model !== undefined
          ? `${params.provider}/${params.model}`
          : params.provider;
      return {
        provider: params.provider,
        ...(params.model !== undefined ? { model: params.model } : {}),
      };
    },

    async setPolicy(params) {
      const live = sessions.get(params.sessionId);
      if (live === undefined) {
        throw new Error(`unknown session: ${params.sessionId}`);
      }
      assertSessionIdle(live);
      const out: { sandbox?: string; approval?: string; autoRun?: string } = {};
      if (params.sandbox !== undefined) {
        live.agent.setPermissionMode(params.sandbox);
        out.sandbox = params.sandbox;
      }
      if (params.approval !== undefined) {
        live.agent.setApprovalPolicy(params.approval);
        out.approval = params.approval;
      }
      if (params.autoRun !== undefined) {
        live.autoRun = params.autoRun;
        out.autoRun = params.autoRun;
      }
      return out;
    },

    async getPolicy(params) {
      const live = sessions.get(params.sessionId);
      if (live === undefined) {
        throw new Error(`unknown session: ${params.sessionId}`);
      }
      return {
        sandbox: live.agent.getPermissionMode(),
        approval: live.agent.getApprovalPolicy(),
        ...(live.autoRun !== undefined ? { autoRun: live.autoRun } : {}),
      };
    },

    async gitDiff(params) {
      const live = sessions.get(params.sessionId);
      if (live === undefined) {
        throw new Error(`unknown session: ${params.sessionId}`);
      }
      const cwd = live.agent.cwd;
      const result = runGitDiff(cwd, {
        ...(params.staged !== undefined ? { staged: params.staged } : {}),
        ...(params.stat !== undefined ? { stat: params.stat } : {}),
      });
      return { output: formatGitOutput(result) };
    },

    async gitStatus(params) {
      const live = requireLive(sessions, params.sessionId);
      const result = runGitStatus(live.agent.cwd);
      return { output: formatGitOutput(result) };
    },

    async getSessionContext(params) {
      const live = requireLive(sessions, params.sessionId);
      const cost = live.agent.getCost();
      return {
        messageCount: live.agent.getMessageCount(),
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        costUsd: cost.costUsd,
      };
    },

    async listSessionHooks(params) {
      const live = requireLive(sessions, params.sessionId);
      return { hooks: [...live.agent.getHooks()] };
    },

    async listSessionMcp(params) {
      const live = requireLive(sessions, params.sessionId);
      const registry = live.agent.mcpClients;
      if (registry === undefined) {
        return { servers: [] };
      }
      return { servers: [...registry.list()] };
    },

    async listSessionAgents(params) {
      const live = requireLive(sessions, params.sessionId);
      const submitter = live.agent.getMeshSubmitter();
      const records =
        submitter !== undefined &&
        typeof submitter.listSubagents === "function"
          ? submitter.listSubagents()
          : [];
      return { output: formatSubagentRecords(records) };
    },

    async sessionPlan(params) {
      const live = requireLive(sessions, params.sessionId);
      assertSessionIdle(live);
      const action = params.action as PlanAction;
      const output = runPlanAction(
        live.agent.getSession(),
        action,
        params.text,
        params.reason,
      );
      return { output };
    },

    async sessionMemory(params) {
      if (options.memoryStore === undefined) {
        throw new Error("memory store not configured");
      }
      requireLive(sessions, params.sessionId);
      const output = await runMemoryOp(
        options.memoryStore,
        params.op,
        params.name,
        params.body,
      );
      return { output };
    },

    async sessionReview(params) {
      const live = requireLive(sessions, params.sessionId);
      assertSessionIdle(live);
      const output = await runSessionReview(
        live.agent,
        live.agent.cwd,
        params.staged === true,
      );
      return { output };
    },

    async sessionInit(params) {
      const live = requireLive(sessions, params.sessionId);
      assertSessionIdle(live);
      const result = await runSessionInit(live.agent, live.agent.cwd);
      return { output: result.preview };
    },

    getConfig() {
      const base = options.getConfig?.() ?? { version: "0.0.0" };
      for (const live of sessions.values()) {
        if (live.modelLabel !== undefined) {
          return {
            ...base,
            model: live.modelLabel,
            ...(live.providerLabel !== undefined
              ? { provider: live.providerLabel }
              : {}),
          };
        }
      }
      return base;
    },
    ...(options.listPeers !== undefined
      ? { listPeers: options.listPeers }
      : {}),
    ...(options.clusterStatus !== undefined
      ? { clusterStatus: options.clusterStatus }
      : {}),
    ...(options.teamJobs !== undefined
      ? { teamJobs: options.teamJobs }
      : {}),
    ...(options.scoreboardSummary !== undefined
      ? { scoreboardSummary: options.scoreboardSummary }
      : {}),
    ...(options.listTools !== undefined ? { listTools: options.listTools } : {}),
  };
}
