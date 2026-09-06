/**
 * Phase E — ProtocolSessionBackend backed by Agent.run().
 */

import type { MemoryStore } from "../memories/store.js";
import type { Agent, AgentResult } from "../agent.js";
import { hasTurnHints } from "../interaction/turn-hints.js";
import { createProviderAdapter } from "../llm/index.js";
import { newSessionId } from "../session.js";
import type { AskHandler } from "../types.js";
import type { Tracer } from "../trace/types.js";
import { traceEventToActivity } from "./activity-format.js";
import { stripThinking } from "../util/strip-thinking.js";
import { formatGitOutput, runGitDiff, runGitStatus } from "./git-runner.js";
import { traceEventToCommittedMessage } from "./message-format.js";
import {
  ensurePlanDocumentActive,
  formatSubagentRecords,
  runMemoryOp,
  runPlanAction,
  runSessionInit,
  runSessionReview,
  summarizeDroppedMessages,
  type PlanAction,
} from "./session-ops.js";
import {
  matchPermissionPreset,
  resolvePermissionPreset,
} from "../permissions/presets.js";
import { buildTurnOutlineFromMessages } from "../session/turn-outline.js";
import type { Session } from "../session.js";
import { SessionStore } from "../session/session-store.js";
import type { UserQuestionService } from "../interaction/user-questions.js";
import {
  cancelPendingUserQuestions,
  createHostAskHandler,
  emptyLiveSession,
  installLivePermissionHook,
  wireHostUserQuestions,
  type LiveSession,
} from "./agent-backend-host.js";
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
    /**
     * R4.1 — host-bridged user questions for `ask_user` / plan mode.
     * Always provided by the agent backend; hosts answer via
     * `session/user_question` JSON-RPC.
     */
    userQuestions: UserQuestionService;
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
      if (doomed !== undefined) cancelPendingUserQuestions(doomed);
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
      const live = emptyLiveSession();
      const askHandler = createHostAskHandler(live, sessionId);
      const userQuestions = wireHostUserQuestions(live, sessionId);
      live.agent = options.createAgent({
        sessionId,
        cwd,
        askHandler,
        userQuestions,
        ...(persisted !== undefined ? { session: persisted } : {}),
      });
      installLivePermissionHook(live, options.shouldAskTool);
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
        cancelPendingUserQuestions(doomed);
        doomed.agent.abort("session replaced");
        sessions.delete(sessionId);
      }
      const live = emptyLiveSession();
      const askHandler = createHostAskHandler(live, sessionId);
      const userQuestions = wireHostUserQuestions(live, sessionId);
      live.agent = options.createAgent({
        sessionId,
        cwd,
        askHandler,
        userQuestions,
        session: persisted,
      });
      installLivePermissionHook(live, options.shouldAskTool);
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
      live.requestUserQuestion =
        params.requestUserQuestion !== undefined
          ? async (req) => {
              const raw = await params.requestUserQuestion!(req);
              return {
                value: typeof raw.value === "string" ? raw.value : "",
                ...(typeof raw.optionIndex === "number"
                  ? { optionIndex: raw.optionIndex }
                  : {}),
                cancelled: raw.cancelled === true,
                ...(raw.cancelled === true
                  ? { cancelledReason: "aborted" as const }
                  : {}),
              };
            }
          : undefined;
      const ac = new AbortController();
      live.abort = ac;
      const onAbort = (): void => {
        live.agent.assistantStreamSink = undefined;
        live.agent.toolOutputSink = undefined;
        ac.abort();
        live.permissionWait?.resolve("deny");
        live.permissionWait = undefined;
        cancelPendingUserQuestions(live);
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
          const raw = messageText(m.content);
          const text =
            m.role === "assistant" ? stripThinking(raw) : raw;
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
        live.requestUserQuestion = undefined;
        cancelPendingUserQuestions(live);
      }
    },

    cancel(sessionId) {
      const live = sessions.get(sessionId);
      if (live === undefined) return;
      live.abort?.abort();
      live.permissionWait?.resolve("deny");
      live.permissionWait = undefined;
      cancelPendingUserQuestions(live);
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
      const out: {
        sandbox?: string;
        approval?: string;
        autoRun?: string;
        preset?: string;
      } = {};
      if (params.preset !== undefined) {
        const preset = resolvePermissionPreset(params.preset);
        live.agent.setPermissionMode(preset.permissionMode);
        live.agent.setApprovalPolicy(preset.askForApproval);
        live.autoRun = preset.autoRun;
        out.preset = preset.name;
        out.sandbox = preset.permissionMode;
        out.approval = preset.askForApproval;
        out.autoRun = preset.autoRun;
        return out;
      }
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
      const sandbox = live.agent.getPermissionMode();
      const approval = live.agent.getApprovalPolicy();
      const preset = matchPermissionPreset({
        permissionMode: sandbox,
        askForApproval: approval,
        ...(live.autoRun !== undefined ? { autoRun: live.autoRun } : {}),
      });
      return {
        sandbox,
        approval,
        ...(live.autoRun !== undefined ? { autoRun: live.autoRun } : {}),
        ...(preset !== undefined ? { preset } : {}),
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

    async getTurnOutline(params) {
      const live = requireLive(sessions, params.sessionId);
      return buildTurnOutlineFromMessages(
        live.agent.session.id,
        live.agent.session.messages,
      );
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
      // Keep Agent's collaboration helper in sync for /mode restore.
      if (action === "enter") {
        live.agent.setCollaborationMode("plan");
      } else if (action === "exit" || action === "approve") {
        live.agent.setCollaborationMode("default");
      }
      return { output };
    },

    async setCollaborationMode(params) {
      const live = requireLive(sessions, params.sessionId);
      assertSessionIdle(live);
      if (params.mode === undefined) {
        return { mode: live.agent.getCollaborationMode() };
      }
      live.agent.setCollaborationMode(params.mode);
      if (params.mode === "plan") {
        ensurePlanDocumentActive(live.agent.getSession());
      }
      return { mode: live.agent.getCollaborationMode() };
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
