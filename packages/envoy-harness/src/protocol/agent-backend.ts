/**
 * Phase E — ProtocolSessionBackend backed by Agent.run().
 */

import type { MemoryStore } from "../memories/store.js";
import type { Agent } from "../agent.js";
import { createProviderAdapter } from "../llm/index.js";
import { newSessionId } from "../session.js";
import type { AskHandler } from "../types.js";
import type { WorkspaceRegistry } from "../workspace/index.js";
import { formatGitOutput, runGitDiff, runGitStatus } from "./git-runner.js";
import {
  ensurePlanDocumentActive,
  runMemoryOp,
  runPlanAction,
  runSessionInit,
  runSessionReview,
  type PlanAction,
} from "./session-ops.js";
import {
  addWorkspaceOp,
  interruptAgentOp,
  listSessionAgentsOp,
  listWorkspacesOp,
  removeWorkspaceOp,
  resolveSessionCwd,
  sendAgentMessageOp,
} from "./session-control-ops.js";
import {
  mergeLabeledConfig,
  sessionContextOp,
  turnOutlineOp,
  type SessionConfigLabels,
} from "./session-introspection-ops.js";
import {
  matchPermissionPreset,
  resolvePermissionPreset,
} from "../permissions/presets.js";
import type { Session } from "../session.js";
import { SessionStore } from "../session/session-store.js";
import { messagesToUiTranscript } from "./transcript-ui.js";
import type { UserQuestionService } from "../interaction/user-questions.js";
import {
  DEFAULT_SESSION_ACQUIRE_TIMEOUT_MS,
  acquirePersistedSession,
  cancelPendingUserQuestions,
  createHostAskHandler,
  emptyLiveSession,
  installLivePermissionHook,
  retireLiveSession,
  wireHostUserQuestions,
  type LiveSession,
} from "./agent-backend-host.js";
import type {
  ProtocolClusterStatus,
  ProtocolScoreboardEntry,
  ProtocolTeamJob,
  ProtocolPeerInfo,
  ProtocolSessionBackend,
  ProtocolToolInfo,
} from "./session-backend.js";
import {
  runSessionCompact,
  runSessionPrompt,
} from "./session-prompt-ops.js";

export interface AgentSessionBackendOptions {
  /**
   * Bound on session acquisition (file open + lease + transcript parse).
   *
   * ACP requests have no deadline of their own, so a contended lock or a
   * very large transcript would hang the request forever with no output.
   * On timeout the acquisition is **not abandoned**: `SessionInitGuard`
   * retains the in-flight promise and releases whatever lease it installs,
   * which is the whole reason the guard exists. `0` disables the bound.
   */
  sessionAcquireTimeoutMs?: number;
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
  /**
   * Optional workspace (project) registry. When set, the backend serves
   * `workspace/list|add|remove`, which is what lets a host open a project
   * other than the one it started in. When absent, `list` reports an empty
   * list and the mutators explain that no registry is wired — an empty
   * list is the honest answer for "no projects yet" either way.
   */
  workspaces?: WorkspaceRegistry;
}

function assertSessionIdle(live: LiveSession): void {
  if (live.abort !== undefined) {
    throw new Error("session busy");
  }
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
  const acquireTimeoutMs =
    options.sessionAcquireTimeoutMs ?? DEFAULT_SESSION_ACQUIRE_TIMEOUT_MS;


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
      retireLiveSession(doomed, "session evicted");
    }
  };

  return {
    async createSession(params) {
      pruneIfNeeded();
      const cwd = await resolveSessionCwd({
        requested: params?.cwd,
        persisted: undefined,
        fallback: options.defaultCwd ?? process.cwd(),
        registry: options.workspaces,
      });
      let sessionId: string;
      let persisted:
        | import("../session/persisted-session.js").PersistedSession
        | undefined;
      if (options.sessionStore !== undefined) {
        persisted = await acquirePersistedSession(
          () =>
            options.sessionStore!.create({
              cwd,
              startedAt: new Date().toISOString(),
              permissionMode: "workspace-write",
            }),
          acquireTimeoutMs,
        );
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
      // Keep the project's "last used" fresh for the UI. Best-effort: a
      // registry failure must never prevent a session from starting, and
      // an unregistered directory is simply not tracked.
      void options.workspaces?.touch(cwd).catch(() => undefined);
      return { sessionId };
    },

    async loadSession(params) {
      if (options.sessionStore === undefined) {
        throw new Error("session store not configured");
      }
      pruneIfNeeded();
      const persisted = await acquirePersistedSession(
        () => options.sessionStore!.load(params.sessionId),
        acquireTimeoutMs,
      );
      const sessionId = persisted.id;
      const cwd = await resolveSessionCwd({
        requested: params.cwd,
        persisted: persisted.metadata.cwd,
        fallback: options.defaultCwd,
        registry: options.workspaces,
      });
      const doomed = sessions.get(sessionId);
      if (doomed !== undefined) {
        retireLiveSession(doomed, "session replaced");
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
      return {
        sessionId,
        messages: messagesToUiTranscript(persisted.messages),
      };
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
      return runSessionPrompt(live, params, {
        ...(options.memoryStore !== undefined
          ? { memoryStore: options.memoryStore }
          : {}),
        ...(options.scoreboardSummary !== undefined
          ? { scoreboardSummary: options.scoreboardSummary }
          : {}),
      });
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
      return runSessionCompact(live, params);
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
        ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
      });
      live.agent.setModel(adapter);
      live.providerLabel = params.provider;
      live.modelLabel =
        params.model !== undefined
          ? `${params.provider}/${params.model}`
          : params.provider;
      if (params.baseUrl !== undefined) {
        live.baseUrlLabel = params.baseUrl;
      } else {
        live.baseUrlLabel = null;
      }
      return {
        provider: params.provider,
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
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
      return sessionContextOp(requireLive(sessions, params.sessionId).agent);
    },

    async getTurnOutline(params) {
      return turnOutlineOp(requireLive(sessions, params.sessionId).agent.session);
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
      return listSessionAgentsOp(live.agent.getMeshSubmitter());
    },

    async sendAgentMessage(params) {
      const live = requireLive(sessions, params.sessionId);
      return sendAgentMessageOp(live.agent.getMeshSubmitter(), params);
    },

    async interruptAgent(params) {
      const live = requireLive(sessions, params.sessionId);
      return interruptAgentOp(live.agent.getMeshSubmitter(), params);
    },

    async listWorkspaces() {
      return listWorkspacesOp(options.workspaces);
    },

    async addWorkspace(params) {
      return addWorkspaceOp(options.workspaces, params);
    },

    async removeWorkspace(params) {
      return removeWorkspaceOp(options.workspaces, params);
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
      const labels: SessionConfigLabels[] = [];
      for (const live of sessions.values()) {
        labels.push({
          ...(live.modelLabel !== undefined ? { model: live.modelLabel } : {}),
          ...(live.providerLabel !== undefined
            ? { provider: live.providerLabel }
            : {}),
          ...(live.baseUrlLabel !== undefined
            ? { baseUrl: live.baseUrlLabel }
            : {}),
        });
      }
      return mergeLabeledConfig(base, labels);
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
