/**
 * Phase E — ProtocolSessionBackend backed by Agent.run().
 */

import type { MemoryStore } from "../memories/store.js";
import type { Agent } from "../agent.js";
import {
  createDecisionClient,
  decisionConfigPublic,
  defaultDecisionConfig,
  patchDecisionConfig,
  type DecisionConfig,
  type DecisionConfigLayer,
  type DecisionInputGuardConfig,
  type DecisionModelRouterConfig,
} from "../decision/index.js";
import { createProviderAdapter } from "../llm/index.js";
import { newSessionId } from "../session.js";
import type { AskHandler } from "../types.js";
import { VERSION } from "../version.js";
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
  attachWorkspaceFileOp,
  listWorkspaceFsOp,
  readWorkspaceFsOp,
} from "./workspace-fs-ops.js";
import {
  closeTerminalOp,
  listTerminalsOp,
  mapTerminalError,
  openTerminalOp,
  readTerminalOp,
  writeTerminalOp,
} from "./terminal-ops.js";
import type { TerminalSessionService } from "../terminal/types.js";
import {
  mergeLabeledConfig,
  sessionContextOp,
  turnOutlineOp,
  type SessionConfigLabels,
} from "./session-introspection-ops.js";
import { matchPermissionPreset } from "../permissions/presets.js";
import type { Session } from "../session.js";
import { SessionStore } from "../session/session-store.js";
import { messagesToUiTranscript } from "./transcript-ui.js";
import type { UserQuestionService } from "../interaction/user-questions.js";
import {
  DEFAULT_SESSION_ACQUIRE_TIMEOUT_MS,
  acquirePersistedSession,
  applyDecisionGateConfig,
  cancelPendingUserQuestions,
  createHostAskHandler,
  emptyLiveSession,
  installLivePermissionHook,
  retireLiveSession,
  syncDecisionGateToLive,
  wireHostUserQuestions,
  type DecisionGateHandle,
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
  /**
   * Optional System One decision gate (Laya / Jev). Default off.
   * Hosts may also update via `session/set_decision`.
   */
  decision?: DecisionConfig;
  /**
   * R4.5b — seed LiveSession.autoRun from the host runtime config
   * (e.g. `--permission-preset mobile` → `safe-only`) so tool asks
   * honor the preset before any later `setPolicy` call.
   */
  initialAutoRun?: import("../permissions/auto-run.js").AutoRunPolicy;
  /**
   * Wave 3 — shared terminal session service for interactive ACP PTY.
   * Owner fence is the ACP session id.
   */
  terminals?: TerminalSessionService;
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

  const initialDecision = options.decision ?? defaultDecisionConfig();
  const decisionGate: DecisionGateHandle = {
    config: initialDecision,
    client: createDecisionClient(initialDecision),
  };

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
      if (options.initialAutoRun !== undefined) {
        live.autoRun = options.initialAutoRun;
      } else if (live.agent.autoRun !== undefined) {
        live.autoRun = live.agent.autoRun;
      }
      installLivePermissionHook(live, options.shouldAskTool, decisionGate);
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
      if (options.initialAutoRun !== undefined) {
        live.autoRun = options.initialAutoRun;
      } else if (live.agent.autoRun !== undefined) {
        live.autoRun = live.agent.autoRun;
      }
      installLivePermissionHook(live, options.shouldAskTool, decisionGate);
      sessions.set(sessionId, live);
      return {
        sessionId,
        cwd,
        messages: messagesToUiTranscript(persisted.messages),
      };
    },

    async listSessions() {
      if (options.sessionStore === undefined) {
        return [];
      }
      return await options.sessionStore.listSummaries();
    },

    async deleteSession(sessionId: string) {
      if (options.sessionStore === undefined) {
        return { deleted: false };
      }
      const live = sessions.get(sessionId);
      if (live !== undefined) {
        sessions.delete(sessionId);
        // Same cleanup as eviction / replace: abort, flush session file,
        // and drop any Playwright page keyed to this session.
        retireLiveSession(live, "session deleted");
      }
      const deleted = await options.sessionStore.delete(sessionId);
      return { deleted };
    },

    async prompt(params) {
      const live = sessions.get(params.sessionId);
      if (live === undefined) {
        throw new Error(`unknown session: ${params.sessionId}`);
      }
      // Wave 3 — claim due schedules into the inbox before the turn.
      live.agent.tickSchedules();
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
      live.agent.setModel(adapter, {
        provider: params.provider,
        ...(params.model !== undefined ? { model: params.model } : {}),
      });
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

    async setDecision(params) {
      const live = sessions.get(params.sessionId);
      if (live === undefined) {
        throw new Error(`unknown session: ${params.sessionId}`);
      }
      assertSessionIdle(live);
      const patch: DecisionConfigLayer = {
        ...(params.mode !== undefined ? { mode: params.mode } : {}),
        ...(params.backend !== undefined ? { backend: params.backend } : {}),
        ...(params.endpoint !== undefined ? { endpoint: params.endpoint } : {}),
        ...(params.timeoutMs !== undefined
          ? { timeoutMs: params.timeoutMs }
          : {}),
        ...(params.apiKeyEnv !== undefined
          ? { apiKeyEnv: params.apiKeyEnv }
          : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.safeAuto !== undefined
          ? { safeAuto: params.safeAuto }
          : {}),
        ...(params.modelRouter !== undefined
          ? {
              modelRouter: {
                ...params.modelRouter,
                ...(params.modelRouter.profiles !== undefined
                  ? {
                      profiles: params.modelRouter.profiles.map((p) => ({
                        ...p,
                      })),
                    }
                  : {}),
              } satisfies Partial<DecisionModelRouterConfig>,
            }
          : {}),
        ...(params.inputGuard !== undefined
          ? {
              inputGuard: {
                ...params.inputGuard,
              } satisfies Partial<DecisionInputGuardConfig>,
            }
          : {}),
      };
      const next = patchDecisionConfig(decisionGate.config, patch);
      applyDecisionGateConfig(decisionGate, next);
      for (const s of sessions.values()) {
        syncDecisionGateToLive(s, decisionGate);
      }
      return decisionConfigPublic(decisionGate.config);
    },

    async setPolicy(params) {
      const live = sessions.get(params.sessionId);
      if (live === undefined) {
        throw new Error(`unknown session: ${params.sessionId}`);
      }
      // autoRun alone is a flag the next shouldAsk reads — safe while a turn is
      // blocked on a permission ask (hosts offer "don't ask again" on that card).
      // Sandbox / approval / preset still need an idle session.
      const onlyAutoRun =
        params.autoRun !== undefined &&
        params.preset === undefined &&
        params.sandbox === undefined &&
        params.approval === undefined;
      if (!onlyAutoRun) assertSessionIdle(live);
      const out: {
        sandbox?: string;
        approval?: string;
        autoRun?: string;
        preset?: string;
      } = {};
      if (params.preset !== undefined) {
        // Use Agent.setPermissionPreset so mobile (and future presets)
        // also expand networkAccess + writableRoots — not just mode/approval.
        const preset = live.agent.setPermissionPreset(params.preset);
        live.autoRun = preset.autoRun;
        out.preset = preset.name;
        out.sandbox = preset.permissionMode;
        out.approval = preset.askForApproval;
        out.autoRun = preset.autoRun;
      }
      // Co-sent axes apply on top of the preset (one-knob first, then tweaks).
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
        // Keep Agent.autoRun in sync so getPermissionPreset() / get_policy
        // do not report a stale named preset with a different auto-run axis.
        live.agent.autoRun = params.autoRun;
        out.autoRun = params.autoRun;
      }
      // After axis overrides, refresh the reported named preset (may clear).
      if (
        params.preset !== undefined &&
        (params.sandbox !== undefined ||
          params.approval !== undefined ||
          params.autoRun !== undefined)
      ) {
        const matched = live.agent.getPermissionPreset();
        if (matched !== undefined) out.preset = matched;
        else delete out.preset;
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
      // Prefer the named preset on the agent (mobile vs webdev share axes).
      const preset =
        live.agent.getPermissionPreset() ??
        matchPermissionPreset({
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

    async listWorkspaceFs(params) {
      const live = requireLive(sessions, params.sessionId);
      const rootCwd = live.agent.getSession().metadata.cwd;
      return listWorkspaceFsOp({
        rootCwd,
        ...(params.path !== undefined ? { path: params.path } : {}),
        ...(options.workspaces !== undefined
          ? { registry: options.workspaces }
          : {}),
      });
    },

    async readWorkspaceFs(params) {
      const live = requireLive(sessions, params.sessionId);
      const rootCwd = live.agent.getSession().metadata.cwd;
      return readWorkspaceFsOp({
        rootCwd,
        path: params.path,
        ...(params.maxBytes !== undefined
          ? { maxBytes: params.maxBytes }
          : {}),
        ...(options.workspaces !== undefined
          ? { registry: options.workspaces }
          : {}),
      });
    },

    async attachWorkspaceFile(params) {
      const live = requireLive(sessions, params.sessionId);
      const rootCwd = live.agent.getSession().metadata.cwd;
      return attachWorkspaceFileOp({
        rootCwd,
        name: params.name,
        dataBase64: params.dataBase64,
        ...(params.mimeType !== undefined
          ? { mimeType: params.mimeType }
          : {}),
        ...(options.workspaces !== undefined
          ? { registry: options.workspaces }
          : {}),
      });
    },

    async openTerminal(params) {
      if (options.terminals === undefined) {
        throw new Error("terminal service not wired");
      }
      requireLive(sessions, params.sessionId);
      try {
        const live = requireLive(sessions, params.sessionId);
        const cwd =
          params.cwd ?? live.agent.getSession().metadata.cwd;
        return await openTerminalOp(options.terminals, params.sessionId, {
          cwd,
          ...(params.name !== undefined ? { name: params.name } : {}),
        });
      } catch (err) {
        throw mapTerminalError(err);
      }
    },

    async writeTerminal(params) {
      if (options.terminals === undefined) {
        throw new Error("terminal service not wired");
      }
      requireLive(sessions, params.sessionId);
      try {
        return await writeTerminalOp(
          options.terminals,
          params.sessionId,
          {
            terminalId: params.terminalId,
            data: params.data,
            ...(params.submit !== undefined ? { submit: params.submit } : {}),
            ...(params.onDelta !== undefined
              ? { onDelta: params.onDelta }
              : {}),
          },
        );
      } catch (err) {
        throw mapTerminalError(err);
      }
    },

    async readTerminal(params) {
      if (options.terminals === undefined) {
        throw new Error("terminal service not wired");
      }
      requireLive(sessions, params.sessionId);
      try {
        return readTerminalOp(options.terminals, params.sessionId, {
          terminalId: params.terminalId,
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.count !== undefined ? { count: params.count } : {}),
        });
      } catch (err) {
        throw mapTerminalError(err);
      }
    },

    async listTerminals(params) {
      if (options.terminals === undefined) {
        throw new Error("terminal service not wired");
      }
      requireLive(sessions, params.sessionId);
      return listTerminalsOp(options.terminals, params.sessionId);
    },

    async closeTerminal(params) {
      if (options.terminals === undefined) {
        throw new Error("terminal service not wired");
      }
      requireLive(sessions, params.sessionId);
      try {
        return await closeTerminalOp(options.terminals, params.sessionId, {
          terminalId: params.terminalId,
        });
      } catch (err) {
        throw mapTerminalError(err);
      }
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

    async sessionSchedule(params) {
      const live = requireLive(sessions, params.sessionId);
      if (params.action === "list") {
        const schedules = live.agent.listSchedules().map((t) => ({
          id: t.id,
          prompt: t.prompt,
          enabled: t.enabled,
          createdAt: t.createdAt,
          recurrence: t.recurrence,
          ...(t.lastFiredAt !== undefined
            ? { lastFiredAt: t.lastFiredAt }
            : {}),
        }));
        return {
          schedules,
          enabled: live.agent.tools.has("schedule_list"),
        };
      }
      if (params.action === "tick") {
        const fired = live.agent.tickSchedules();
        return {
          fired,
          enabled: live.agent.tools.has("schedule_list"),
        };
      }
      // create
      try {
        const task = live.agent.createSchedule({
          prompt: params.prompt!,
          ...(params.runAt !== undefined ? { runAt: params.runAt } : {}),
          ...(params.everyMs !== undefined ? { everyMs: params.everyMs } : {}),
        });
        return {
          schedule: {
            id: task.id,
            prompt: task.prompt,
            enabled: task.enabled,
            createdAt: task.createdAt,
            recurrence: task.recurrence,
            ...(task.lastFiredAt !== undefined
              ? { lastFiredAt: task.lastFiredAt }
              : {}),
          },
          enabled: true,
        };
      } catch (err) {
        return {
          enabled: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async sessionGoals(params) {
      const live = requireLive(sessions, params.sessionId);
      if (params.action === "list") {
        const goals = live.agent.listGoals().map((g) => ({
          id: g.id,
          title: g.title,
          status: g.status,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
          ...(g.detail !== undefined ? { detail: g.detail } : {}),
        }));
        return {
          goals,
          enabled: live.agent.tools.has("create_goal"),
        };
      }
      try {
        const goal = live.agent.createGoal({
          title: params.title!,
          ...(params.detail !== undefined ? { detail: params.detail } : {}),
        });
        return {
          goal: {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
            ...(goal.detail !== undefined ? { detail: goal.detail } : {}),
          },
          enabled: true,
        };
      } catch (err) {
        return {
          enabled: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    getConfig() {
      const base = options.getConfig?.() ?? { version: VERSION };
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
      const decisionPub = decisionConfigPublic(decisionGate.config);
      // Surface last model-router choice from any live session (newest wins).
      let lastChosen: string | undefined;
      for (const live of sessions.values()) {
        if (live.agent.decisionModelRouterLastChosen !== undefined) {
          lastChosen = live.agent.decisionModelRouterLastChosen;
        }
      }
      if (lastChosen !== undefined) {
        const mr = decisionPub["modelRouter"];
        if (mr !== null && typeof mr === "object") {
          (mr as Record<string, unknown>)["lastChosen"] = lastChosen;
        }
      }
      return {
        ...mergeLabeledConfig(base, labels),
        decision: decisionPub,
      };
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
