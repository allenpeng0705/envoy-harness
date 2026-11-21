/**
 * High-level ACP host over the browser WebSocket JSON-RPC client.
 *
 * Connection recovery follows deepseek-harness patterns: exponential
 * backoff, manual reconnect(), and an explicit connectionState.
 */

import { formatActivityLine, type ActivityLike } from "./activity.js";
import {
  applyToolActivity,
  isToolTrajectoryActivity,
} from "../trajectory.js";
import {
  mergeUniquePaths,
  parseChangedPathsFromSummary,
  parseTurnHints,
  pathsFromMutatingTool,
} from "../composer-docks.js";
import {
  mergePromptRows,
  parseAvailableCommandsUpdate,
  parseSessionTokenDelta,
  parseSessionUpdateMessage,
  rowsFromPromptResult,
} from "./acp-notifications.js";
import {
  type AcpHostState,
  type AgentInterruptResult,
  type AgentMessageResult,
  type ChatMessage,
  type ChatRole,
  type SessionContextStats,
  type SessionSummary,
  type WorkspaceEntry,
} from "./host-types.js";
import {
  requestAddWorkspace,
  requestAgentInterrupt,
  requestAgentMessage,
  requestRemoveWorkspace,
  requestWorkspaces,
  sessionNewParams,
} from "./host-control.js";
import {
  bootstrapAcpSession,
  writeLastSessionId,
} from "./host-bootstrap.js";
import { fetchMeshSnapshot } from "./mesh-snapshot.js";
import {
  connectAcpWs,
  type WsJsonRpcClient,
} from "./ws-jsonrpc.js";

export type {
  AcpHostState,
  AgentInterruptResult,
  AgentMessageResult,
  ChatMessage,
  ChatRole,
  ConnectionState,
  DeferredTask,
  MeshAgent,
  MeshAgentStatus,
  MeshSnapshot,
  PermissionPrompt,
  SessionSummary,
  ToolPhase,
  ToolTrajectory,
  SessionContextStats,
  TurnHints,
  UserQuestionPrompt,
  WorkspaceEntry,
} from "./host-types.js";

type Listener = () => void;
type TerminalOutputListener = (ev: {
  sessionId: string;
  terminalId: string;
  data: string;
}) => void;

let msgSeq = 0;
function nextMsgId(): string {
  msgSeq += 1;
  return `m${msgSeq}`;
}

const BACKOFF_CAPS_MS = [500, 1000, 2000, 4000, 8000, 10_000] as const;
const MESH_POLL_MS = 5_000;

function jitteredDelay(capMs: number): number {
  return Math.floor(capMs * (0.5 + Math.random() * 0.5));
}

/** Per-session UI snapshot so tabs can soft-switch without cancelling turns. */
interface SessionViewCache {
  messages: ChatMessage[];
  cwd: string;
  changedFiles: string[];
  turnHints: AcpHostState["turnHints"];
  contextStats: AcpHostState["contextStats"];
  slashCatalog: AcpHostState["slashCatalog"];
}

export class AcpHost {
  #client: WsJsonRpcClient | undefined;
  #listeners = new Set<Listener>();
  #terminalListeners = new Set<TerminalOutputListener>();
  #disposed = false;
  #connecting = false;
  #autoRetry = true;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #meshTimer: ReturnType<typeof setInterval> | undefined;
  #retryAttempt = 0;
  #generation = 0;
  /** M1 — sessions with an in-flight turn (server allows concurrent). */
  #busySessions = new Set<string>();
  /** M1 — sessions loaded into this host that can soft-switch without reload. */
  #warmSessions = new Set<string>();
  /** M1 — cached transcripts / docks for background tabs. */
  #sessionCaches = new Map<string, SessionViewCache>();
  #state: AcpHostState = {
    connectionState: "idle",
    ready: false,
    busy: false,
    sessionId: null,
    protocolVersion: null,
    model: "",
    provider: "",
    baseUrl: "",
    decisionMode: "off",
    decisionBackend: "null",
    decisionEndpoint: "",
    sandbox: "read-only",
    approval: "on-request",
    autoRun: "always-confirm",
    peerCount: 0,
    mesh: null,
    cwd: "",
    messages: [],
    error: null,
    retryAttempt: 0,
    permission: null,
    userQuestion: null,
    changedFiles: [],
    turnHints: null,
    slashCatalog: null,
    contextStats: null,
    busySessionIds: [],
    sessionCacheEpoch: 0,
  };

  get state(): AcpHostState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const l of [...this.#listeners]) l();
  }

  #patch(partial: Partial<AcpHostState>): void {
    this.#state = { ...this.#state, ...partial };
    this.#emit();
  }

  #pushMessage(role: ChatRole, text: string): void {
    if (!text) return;
    this.#patch({
      messages: [
        ...this.#state.messages,
        { id: nextMsgId(), role, text, at: Date.now() },
      ],
    });
  }

  /** M1 — whether a session (default: active) has an in-flight turn. */
  isSessionBusy(sessionId?: string | null): boolean {
    const id = sessionId ?? this.#state.sessionId;
    if (id === null || id === undefined) return false;
    return this.#busySessions.has(id);
  }

  #syncBusyFlag(): void {
    const active = this.#state.sessionId;
    const busy = active !== null && this.#busySessions.has(active);
    if (this.#state.busy !== busy) this.#patch({ busy });
  }

  #markSessionBusy(sessionId: string, busy: boolean): void {
    if (busy) this.#busySessions.add(sessionId);
    else this.#busySessions.delete(sessionId);
    this.#patch({ busySessionIds: [...this.#busySessions] });
    this.#syncBusyFlag();
  }

  #snapshotActiveCache(): void {
    const id = this.#state.sessionId;
    if (id === null) return;
    this.#sessionCaches.set(id, {
      messages: this.#state.messages,
      cwd: this.#state.cwd,
      changedFiles: this.#state.changedFiles,
      turnHints: this.#state.turnHints,
      contextStats: this.#state.contextStats,
      slashCatalog: this.#state.slashCatalog,
    });
    this.#warmSessions.add(id);
  }

  #ensureCache(sessionId: string): SessionViewCache {
    const existing = this.#sessionCaches.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh: SessionViewCache = {
      messages: [],
      cwd: this.#state.cwd,
      changedFiles: [],
      turnHints: null,
      contextStats: null,
      slashCatalog: null,
    };
    this.#sessionCaches.set(sessionId, fresh);
    return fresh;
  }

  #restoreCache(sessionId: string): void {
    const cache = this.#ensureCache(sessionId);
    this.#patch({
      sessionId,
      messages: cache.messages,
      cwd: cache.cwd,
      changedFiles: cache.changedFiles,
      turnHints: cache.turnHints,
      contextStats: cache.contextStats,
      slashCatalog: cache.slashCatalog,
      busy: this.#busySessions.has(sessionId),
      error: null,
      permission: null,
      userQuestion: null,
    });
  }

  #bumpCacheEpoch(): void {
    this.#patch({ sessionCacheEpoch: this.#state.sessionCacheEpoch + 1 });
  }

  #setCacheMessages(sessionId: string, messages: ChatMessage[]): void {
    const cache = this.#ensureCache(sessionId);
    cache.messages = messages;
    // Only notify React for background panes; active view already patched.
    if (sessionId !== this.#state.sessionId) this.#bumpCacheEpoch();
  }

  #mutateSessionMessages(
    sessionId: string,
    mut: (messages: ChatMessage[]) => ChatMessage[],
  ): void {
    if (this.#state.sessionId === sessionId) {
      const next = mut(this.#state.messages);
      this.#patch({ messages: next });
      this.#ensureCache(sessionId).messages = next;
      return;
    }
    const cache = this.#ensureCache(sessionId);
    cache.messages = mut(cache.messages);
    this.#bumpCacheEpoch();
  }

  /** M1 panes — read a session transcript (active or cached). */
  peekSessionMessages(sessionId: string | null): ChatMessage[] {
    if (sessionId === null) return [];
    if (sessionId === this.#state.sessionId) return this.#state.messages;
    return this.#sessionCaches.get(sessionId)?.messages ?? [];
  }

  #clearPendingHostRequests(reason: string): void {
    const perm = this.#state.permission;
    if (perm) {
      perm.resolve("deny");
    }
    const q = this.#state.userQuestion;
    if (q) {
      q.resolve({ value: "", cancelled: true });
    }
    if (perm || q) {
      this.#patch({
        permission: null,
        userQuestion: null,
        error: reason,
      });
    }
  }

  #stopMeshPoll(): void {
    if (this.#meshTimer !== undefined) {
      clearInterval(this.#meshTimer);
      this.#meshTimer = undefined;
    }
  }

  #startMeshPoll(): void {
    this.#stopMeshPoll();
    void this.refreshMesh();
    this.#meshTimer = setInterval(() => {
      void this.refreshMesh();
    }, MESH_POLL_MS);
  }

  /** Refresh peers / cluster / team / local sub-agents snapshot. */
  async refreshMesh(): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || client.closed || !sessionId) return;
    const { mesh, peerCount } = await fetchMeshSnapshot(
      client,
      sessionId,
      this.#state.mesh,
      this.#state.peerCount,
    );
    this.#patch({ mesh, peerCount });
  }

  async connect(): Promise<void> {
    if (this.#disposed) return;
    if (this.#connecting) return;
    this.#connecting = true;
    this.#autoRetry = true;
    const generation = ++this.#generation;

    this.#patch({
      connectionState: "connecting",
      ready: false,
      error: null,
      retryAttempt: this.#retryAttempt,
    });

    try {
      const client = await connectAcpWs(undefined, {
        onClose: () => {
          if (generation !== this.#generation) return;
          this.#onTransportLost("WebSocket closed");
        },
        onError: () => {
          // close handler will fire next
        },
      });
      if (this.#disposed || generation !== this.#generation) {
        client.close();
        return;
      }
      this.#client = client;
      this.#wireClient(client);
      await this.#bootstrapSession(client);

      this.#retryAttempt = 0;
      this.#patch({
        connectionState: "connected",
        ready: true,
        error: null,
        retryAttempt: 0,
      });
      this.#startMeshPoll();
    } catch (err) {
      if (generation !== this.#generation) return;
      const message = err instanceof Error ? err.message : String(err);
      this.#client = undefined;
      this.#patch({
        connectionState: "disconnected",
        ready: false,
        busy: false,
        error: message,
      });
      this.#scheduleRetry();
      throw err;
    } finally {
      this.#connecting = false;
    }
  }

  /** Interrupt backoff and reconnect immediately (dsh-style). */
  async reconnect(): Promise<void> {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#retryAttempt = 0;
    this.#autoRetry = true;
    this.#generation += 1;
    this.#stopMeshPoll();
    this.#clearPendingHostRequests("reconnecting");
    try {
      this.#client?.close();
    } catch {
      // ignore
    }
    this.#client = undefined;
    // Keep sessionId so bootstrap can prefer session/load after reconnect.
    this.#patch({
      connectionState: "connecting",
      ready: false,
      busy: false,
      mesh: null,
      error: null,
      retryAttempt: 0,
    });
    try {
      await this.connect();
    } catch {
      // connect schedules retry
    }
  }

  #onTransportLost(reason: string): void {
    this.#stopMeshPoll();
    this.#clearPendingHostRequests(reason);
    this.#client = undefined;
    this.#patch({
      connectionState: "disconnected",
      ready: false,
      busy: false,
      error: reason,
    });
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (this.#disposed || !this.#autoRetry) return;
    if (this.#retryTimer !== undefined) return;
    const idx = Math.min(this.#retryAttempt, BACKOFF_CAPS_MS.length - 1);
    const cap = BACKOFF_CAPS_MS[idx] ?? 10_000;
    const delay = jitteredDelay(cap);
    this.#retryAttempt += 1;
    this.#patch({ retryAttempt: this.#retryAttempt });

    // After the 10s tier fails once more, stop auto-retry (dsh pattern).
    if (this.#retryAttempt > BACKOFF_CAPS_MS.length) {
      this.#autoRetry = false;
      this.#patch({
        error:
          (this.#state.error ?? "disconnected") +
          " — automatic reconnect stopped. Click Reconnect.",
      });
      return;
    }

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.connect().catch(() => undefined);
    }, delay);
  }

  #wireClient(client: WsJsonRpcClient): void {
    client.onRequest(async (method, params) => {
      if (method === "session/request_permission") {
        const req = params as {
          sessionId: string;
          toolName: string;
          description: string;
          args: unknown;
        };
        // M1 — surface the tab that needs approval.
        if (
          req.sessionId &&
          this.#state.sessionId !== null &&
          req.sessionId !== this.#state.sessionId
        ) {
          this.#snapshotActiveCache();
          if (this.#warmSessions.has(req.sessionId)) {
            this.#restoreCache(req.sessionId);
          }
        }
        const decision = await new Promise<"allow" | "deny">((resolve) => {
          this.#patch({
            permission: {
              sessionId: req.sessionId,
              toolName: req.toolName,
              description: req.description,
              args: req.args,
              resolve,
            },
          });
        });
        this.#patch({ permission: null });
        return { decision };
      }
      if (method === "session/user_question") {
        const req = params as {
          sessionId: string;
          question?: string;
          prompt?: string;
          options?: string[];
          recommendedIndex?: number;
          multiline?: boolean;
          multiple?: boolean;
        };
        if (
          req.sessionId &&
          this.#state.sessionId !== null &&
          req.sessionId !== this.#state.sessionId
        ) {
          this.#snapshotActiveCache();
          if (this.#warmSessions.has(req.sessionId)) {
            this.#restoreCache(req.sessionId);
          }
        }
        const answer = await new Promise<{
          value: string;
          optionIndex?: number;
          optionIndexes?: readonly number[];
          cancelled?: boolean;
        }>((resolve) => {
          this.#patch({
            userQuestion: {
              sessionId: req.sessionId,
              question: req.question ?? req.prompt ?? "Question",
              ...(req.options !== undefined ? { options: req.options } : {}),
              ...(typeof req.recommendedIndex === "number"
                ? { recommendedIndex: req.recommendedIndex }
                : {}),
              ...(req.multiline === true ? { multiline: true } : {}),
              ...(req.multiple === true ? { multiple: true } : {}),
              resolve,
            },
          });
        });
        this.#patch({ userQuestion: null });
        return answer;
      }
      throw new Error(`unhandled server request: ${method}`);
    });

    client.onNotification("session/update", (params) => {
      const cmds = parseAvailableCommandsUpdate(
        params,
        this.#state.sessionId,
      );
      if (cmds !== undefined) {
        this.#patch({ slashCatalog: cmds });
        return;
      }
      const row = parseSessionUpdateMessage(params, this.#state.sessionId);
      if (row === undefined) return;
      if (row.role === "assistant") {
        this.#finalizeAssistant(row.text);
      } else {
        this.#pushMessage(row.role, row.text);
      }
    });

    client.onNotification("session/terminal/output", (params) => {
      const p = params as {
        sessionId?: string;
        terminalId?: string;
        data?: string;
      };
      if (
        typeof p.sessionId !== "string" ||
        typeof p.terminalId !== "string" ||
        typeof p.data !== "string"
      ) {
        return;
      }
      for (const l of this.#terminalListeners) {
        l({
          sessionId: p.sessionId,
          terminalId: p.terminalId,
          data: p.data,
        });
      }
    });

    client.onNotification("session/activity", (params) => {
      const p = params as {
        sessionId?: string;
        activity?: ActivityLike;
      };
      const sid =
        typeof p.sessionId === "string" && p.sessionId.length > 0
          ? p.sessionId
          : this.#state.sessionId;
      if (sid === null) return;
      // Accept activity for any busy session (including background tabs).
      if (!this.#busySessions.has(sid) && !this.#state.busy) return;
      if (p.activity === undefined) return;
      if (p.activity.kind === "model_response") return;
      if (p.activity.kind === "agent_start") return;

      const active = this.#state.sessionId === sid;

      // Wave 4 — tool trajectory cards (including successful results + progress).
      if (isToolTrajectoryActivity(p.activity)) {
        this.#mutateSessionMessages(sid, (messages) =>
          applyToolActivity(messages, p.activity!, nextMsgId),
        );
        if (p.activity.kind === "tool_call") {
          const next = pathsFromMutatingTool(
            p.activity.toolName,
            p.activity.toolArgs,
          );
          if (next.length > 0) {
            if (active) {
              this.#patch({
                changedFiles: mergeUniquePaths(
                  this.#state.changedFiles,
                  next,
                ),
              });
            } else {
              const cache = this.#ensureCache(sid);
              cache.changedFiles = mergeUniquePaths(cache.changedFiles, next);
            }
          }
        }
        if (p.activity.subagentOf !== undefined && active) {
          void this.refreshMesh();
        }
        return;
      }

      const line = formatActivityLine(p.activity);
      if (line) {
        this.#mutateSessionMessages(sid, (messages) => [
          ...messages,
          { id: nextMsgId(), role: "status", text: line, at: Date.now() },
        ]);
      }
      if (p.activity.kind === "agent_end") {
        const fromSummary = parseChangedPathsFromSummary(p.activity.summary);
        if (fromSummary.length > 0) {
          if (active) {
            this.#patch({
              changedFiles: mergeUniquePaths(
                this.#state.changedFiles,
                fromSummary,
              ),
            });
          } else {
            const cache = this.#ensureCache(sid);
            cache.changedFiles = mergeUniquePaths(
              cache.changedFiles,
              fromSummary,
            );
          }
        }
      }
      if (
        active &&
        (p.activity.kind === "agent_end" ||
          p.activity.subagentOf !== undefined)
      ) {
        void this.refreshMesh();
      }
    });

    client.onNotification("session/token", (params) => {
      const raw = (params ?? {}) as {
        sessionId?: string;
        model?: string;
      };
      const sid =
        typeof raw.sessionId === "string" && raw.sessionId.length > 0
          ? raw.sessionId
          : this.#state.sessionId;
      if (sid === null) return;
      const tokenDelta = parseSessionTokenDelta(params, sid);
      if (tokenDelta !== undefined) {
        if (sid === this.#state.sessionId) {
          this.#appendAssistantChunk(tokenDelta);
          this.#setCacheMessages(sid, this.#state.messages);
        } else {
          this.#mutateSessionMessages(sid, (messages) => {
            const last = messages[messages.length - 1];
            if (last !== undefined && last.role === "assistant") {
              const updated = [...messages];
              updated[updated.length - 1] = {
                ...last,
                text: last.text + tokenDelta,
              };
              return updated;
            }
            return [
              ...messages,
              {
                id: nextMsgId(),
                role: "assistant",
                text: tokenDelta,
                at: Date.now(),
              },
            ];
          });
        }
        return;
      }
      if (raw.model) this.#patch({ model: raw.model });
    });

    client.onNotification("discovery/event", (params) => {
      const wrapped = (params ?? {}) as {
        event?: { type?: string; peerId?: string; error?: string };
      };
      const event = wrapped.event ?? (params as { type?: string; peerId?: string });
      const label = event.peerId
        ? `${event.type ?? "event"} · ${event.peerId}`
        : String(event.type ?? "discovery");
      const mesh = this.#state.mesh;
      this.#patch({
        mesh: mesh
          ? { ...mesh, lastDiscovery: label }
          : {
              connected: this.#state.peerCount,
              peerTotal: this.#state.peerCount,
              failed: 0,
              peers: [],
              teamJobsRunning: 0,
              teamJobsTotal: 0,
              agentsSummary: "",
              lastDiscovery: label,
            },
      });
      void this.refreshMesh();
    });
  }

  async #bootstrapSession(client: WsJsonRpcClient): Promise<void> {
    // Reconnect invalidates in-memory warm agents; force cold loads.
    this.#warmSessions.clear();
    this.#busySessions.clear();
    this.#sessionCaches.clear();
    const preferSessionId =
      this.#state.sessionId ?? undefined;
    const boot = await bootstrapAcpSession(client, {
      ...(preferSessionId !== undefined ? { preferSessionId } : {}),
    });
    writeLastSessionId(boot.sessionId);
    const hydrated =
      boot.messages
        ?.filter((m) => m.text && m.text.trim().length > 0)
        .map((m) => {
          const roleRaw = m.role ?? "system";
          const role: ChatRole =
            roleRaw === "user" ||
            roleRaw === "assistant" ||
            roleRaw === "tool" ||
            roleRaw === "system" ||
            roleRaw === "status"
              ? roleRaw
              : "system";
          return {
            id: nextMsgId(),
            role,
            text: m.text!,
            at: Date.now(),
          };
        }) ?? [];
    const messages = boot.resumed
      ? hydrated.length > 0
        ? hydrated
        : this.#state.messages
      : [];
    this.#warmSessions.add(boot.sessionId);
    this.#sessionCaches.set(boot.sessionId, {
      messages,
      cwd: boot.cwd,
      changedFiles: [],
      turnHints: null,
      contextStats: null,
      slashCatalog: null,
    });
    this.#patch({
      sessionId: boot.sessionId,
      protocolVersion: boot.protocolVersion,
      provider: boot.provider,
      model: boot.model,
      baseUrl: boot.baseUrl,
      decisionMode: boot.decisionMode,
      decisionBackend: boot.decisionBackend,
      decisionEndpoint: boot.decisionEndpoint,
      sandbox: boot.sandbox,
      approval: boot.approval,
      autoRun: boot.autoRun,
      cwd: boot.cwd,
      // Resume with rows replaces; resume with empty rows keeps local
      // transcript (avoid wiping the pre-disconnect chat). Fresh session clears.
      messages,
      busy: false,
    });
  }

  #appendAssistantChunk(text: string): void {
    const msgs = this.#state.messages;
    const last = msgs[msgs.length - 1];
    if (last !== undefined && last.role === "assistant") {
      const updated = [...msgs];
      updated[updated.length - 1] = {
        ...last,
        text: last.text + text,
      };
      this.#patch({ messages: updated });
    } else {
      this.#pushMessage("assistant", text);
    }
  }

  /** Replace (or create) the trailing assistant bubble with the final text. */
  #finalizeAssistant(text: string): void {
    const msgs = this.#state.messages;
    const last = msgs[msgs.length - 1];
    if (last !== undefined && last.role === "assistant") {
      const updated = [...msgs];
      updated[updated.length - 1] = { ...last, text };
      this.#patch({ messages: updated });
    } else {
      this.#pushMessage("assistant", text);
    }
  }

  async prompt(
    text: string,
    content?: ReadonlyArray<
      | { type: "text"; text: string }
      | { type: "image"; mimeType: string; data: string }
    >,
  ): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId || !this.#state.ready) {
      throw new Error("not connected");
    }
    if (this.#busySessions.has(sessionId)) {
      throw new Error("session busy");
    }
    this.#pushMessage("user", text);
    // Wave 6 — reset docks for the new turn; hints fill in when prompt returns.
    this.#patch({
      error: null,
      changedFiles: [],
      turnHints: null,
    });
    this.#markSessionBusy(sessionId, true);
    this.#warmSessions.add(sessionId);
    this.#snapshotActiveCache();
    try {
      const res = (await client.request("session/prompt", {
        sessionId,
        ...(content !== undefined && content.length > 0
          ? { content }
          : { text }),
      })) as {
        stopReason?: string;
        messages?: Array<{ role?: string; text?: string }>;
        turnHints?: unknown;
      };
      const rows = rowsFromPromptResult(res.messages);
      const hints = parseTurnHints(res.turnHints);
      const stillActive = this.#state.sessionId === sessionId;
      const baseMessages = stillActive
        ? this.#state.messages
        : this.#ensureCache(sessionId).messages;
      if (rows.length > 0) {
        const merged = mergePromptRows(
          baseMessages.map((m) => ({ role: m.role, text: m.text })),
          rows,
        );
        const rebuilt = merged.map((m, i) => {
          const prev = baseMessages[i];
          if (
            prev !== undefined &&
            prev.role === m.role &&
            prev.text === m.text
          ) {
            return prev;
          }
          return {
            id: prev?.id ?? nextMsgId(),
            role: m.role,
            text: m.text,
            at: prev?.at ?? Date.now(),
          };
        });
        if (stillActive) {
          this.#patch({
            messages: rebuilt,
            ...(hints !== null ? { turnHints: hints } : {}),
          });
          this.#setCacheMessages(sessionId, rebuilt);
        } else {
          const cache = this.#ensureCache(sessionId);
          cache.messages = rebuilt;
          if (hints !== null) cache.turnHints = hints;
        }
      } else if (hints !== null) {
        if (stillActive) this.#patch({ turnHints: hints });
        else this.#ensureCache(sessionId).turnHints = hints;
      }
      if (stillActive) void this.refreshMesh();
    } catch (err) {
      if (this.#state.sessionId === sessionId) {
        this.#patch({
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      this.#markSessionBusy(sessionId, false);
      this.#snapshotActiveCache();
    }
  }

  /** Wave 6 — dismiss Changes dock. */
  clearChangedFiles(): void {
    this.#patch({ changedFiles: [] });
  }

  /** Wave 6 — dismiss TurnHints dock. */
  clearTurnHints(): void {
    this.#patch({ turnHints: null });
  }

  async cancel(): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) return;
    try {
      await client.request("session/cancel", { sessionId });
    } catch (err) {
      this.#patch({
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.#patch({ busy: false });
  }

  async setModel(
    provider: string,
    model: string,
    baseUrl?: string,
  ): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    try {
      const trimmedBase = baseUrl?.trim() ?? "";
      const res = (await client.request("session/set_model", {
        sessionId,
        provider,
        ...(model ? { model } : {}),
        ...(trimmedBase ? { baseUrl: trimmedBase } : {}),
      })) as {
        result?: { provider?: string; model?: string; baseUrl?: string };
      };
      this.#patch({
        provider: res.result?.provider ?? provider,
        model: res.result?.model ?? model,
        baseUrl: res.result?.baseUrl ?? trimmedBase,
        error: null,
      });
    } catch (err) {
      this.#patch({
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async setPolicy(policy: {
    sandbox?: string;
    approval?: string;
    autoRun?: string;
  }): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    try {
      const res = (await client.request("session/set_policy", {
        sessionId,
        ...policy,
      })) as {
        result?: { sandbox?: string; approval?: string; autoRun?: string };
      };
      this.#patch({
        sandbox: res.result?.sandbox ?? policy.sandbox ?? this.#state.sandbox,
        approval:
          res.result?.approval ?? policy.approval ?? this.#state.approval,
        autoRun: res.result?.autoRun ?? policy.autoRun ?? this.#state.autoRun,
        error: null,
      });
    } catch (err) {
      this.#patch({
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async setDecision(partial: {
    mode?: string;
    backend?: string;
    endpoint?: string;
  }): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    try {
      const res = (await client.request("session/set_decision", {
        sessionId,
        ...partial,
      })) as {
        result?: {
          mode?: string;
          backend?: string;
          endpoint?: string;
        };
      };
      this.#patch({
        decisionMode: res.result?.mode ?? partial.mode ?? this.#state.decisionMode,
        decisionBackend:
          res.result?.backend ??
          partial.backend ??
          this.#state.decisionBackend,
        decisionEndpoint:
          res.result?.endpoint ??
          (partial.endpoint !== undefined
            ? partial.endpoint
            : this.#state.decisionEndpoint),
        error: null,
      });
    } catch (err) {
      this.#patch({
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const client = this.#client;
    if (!client) return [];
    const res = (await client.request("sessions/list", {})) as {
      sessions?: Array<{
        sessionId?: string;
        id?: string;
        title?: string;
        cwd?: string;
        startedAt?: string;
        mtimeMs?: number;
        messageCount?: number;
      }>;
    };
    return (res.sessions ?? []).map((s) => {
      const id = s.id ?? s.sessionId ?? "";
      return {
        id,
        mtimeMs: s.mtimeMs ?? 0,
        messageCount: s.messageCount ?? 0,
        ...(s.title !== undefined ? { title: s.title } : {}),
        ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
        ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
      };
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const client = this.#client;
    if (!client) throw new Error("not connected");
    const res = (await client.request("session/delete", { sessionId })) as {
      deleted?: boolean;
    };
    return res.deleted === true;
  }

  /** Wave 8 — list schedules for the active session. */
  async listSchedules(): Promise<{
    schedules: Array<{
      id: string;
      prompt: string;
      enabled: boolean;
      createdAt: string;
      lastFiredAt?: string;
      recurrence:
        | { kind: "once"; at: string }
        | { kind: "interval"; everyMs: number; nextAt: string };
    }>;
    enabled: boolean;
    error?: string;
  }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    const res = (await client.request("session/schedule", {
      sessionId,
      action: "list",
    })) as {
      schedules?: Array<{
        id: string;
        prompt: string;
        enabled: boolean;
        createdAt: string;
        lastFiredAt?: string;
        recurrence:
          | { kind: "once"; at: string }
          | { kind: "interval"; everyMs: number; nextAt: string };
      }>;
      enabled?: boolean;
      error?: string;
    };
    return {
      schedules: res.schedules ?? [],
      enabled: res.enabled !== false,
      ...(res.error !== undefined ? { error: res.error } : {}),
    };
  }

  /** Wave 8 — create a schedule. */
  async createSchedule(input: {
    prompt: string;
    runAt?: string;
    everyMs?: number;
  }): Promise<{
    schedule?: {
      id: string;
      prompt: string;
      enabled: boolean;
      createdAt: string;
      lastFiredAt?: string;
      recurrence:
        | { kind: "once"; at: string }
        | { kind: "interval"; everyMs: number; nextAt: string };
    };
    enabled: boolean;
    error?: string;
  }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    return (await client.request("session/schedule", {
      sessionId,
      action: "create",
      prompt: input.prompt,
      ...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
      ...(input.everyMs !== undefined ? { everyMs: input.everyMs } : {}),
    })) as {
      schedule?: {
        id: string;
        prompt: string;
        enabled: boolean;
        createdAt: string;
        lastFiredAt?: string;
        recurrence:
          | { kind: "once"; at: string }
          | { kind: "interval"; everyMs: number; nextAt: string };
      };
      enabled: boolean;
      error?: string;
    };
  }

  /** Wave 8 — claim due schedules into the inbox. */
  async tickSchedules(): Promise<{
    fired: number;
    enabled: boolean;
    error?: string;
  }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    const res = (await client.request("session/schedule", {
      sessionId,
      action: "tick",
    })) as { fired?: number; enabled?: boolean; error?: string };
    return {
      fired: res.fired ?? 0,
      enabled: res.enabled !== false,
      ...(res.error !== undefined ? { error: res.error } : {}),
    };
  }

  /** Wave 8 — list goals. */
  async listGoals(): Promise<{
    goals: Array<{
      id: string;
      title: string;
      detail?: string;
      status: string;
      createdAt: string;
      updatedAt: string;
    }>;
    enabled: boolean;
    error?: string;
  }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    const res = (await client.request("session/goals", {
      sessionId,
      action: "list",
    })) as {
      goals?: Array<{
        id: string;
        title: string;
        detail?: string;
        status: string;
        createdAt: string;
        updatedAt: string;
      }>;
      enabled?: boolean;
      error?: string;
    };
    return {
      goals: res.goals ?? [],
      enabled: res.enabled !== false,
      ...(res.error !== undefined ? { error: res.error } : {}),
    };
  }

  /** Wave 8 — create a goal. */
  async createGoal(input: {
    title: string;
    detail?: string;
  }): Promise<{
    goal?: {
      id: string;
      title: string;
      detail?: string;
      status: string;
      createdAt: string;
      updatedAt: string;
    };
    enabled: boolean;
    error?: string;
  }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    return (await client.request("session/goals", {
      sessionId,
      action: "create",
      title: input.title,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    })) as {
      goal?: {
        id: string;
        title: string;
        detail?: string;
        status: string;
        createdAt: string;
        updatedAt: string;
      };
      enabled: boolean;
      error?: string;
    };
  }

  /** Wave 9 / M5 — refresh `session/context` into host state. */
  async refreshContext(): Promise<SessionContextStats | null> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId || !this.#state.ready) return null;
    try {
      const res = (await client.request("session/context", {
        sessionId,
      })) as Partial<SessionContextStats>;
      const stats: SessionContextStats = {
        messageCount:
          typeof res.messageCount === "number" ? res.messageCount : 0,
        inputTokens: typeof res.inputTokens === "number" ? res.inputTokens : 0,
        outputTokens:
          typeof res.outputTokens === "number" ? res.outputTokens : 0,
        costUsd: typeof res.costUsd === "number" ? res.costUsd : 0,
      };
      this.#patch({ contextStats: stats });
      return stats;
    } catch {
      return this.#state.contextStats;
    }
  }

  /** Wave 9 / M5 — compact transcript (keep N turns). */
  async compactSession(keep = 6): Promise<{
    messageCountBefore: number;
    messageCountAfter: number;
    droppedCount: number;
  }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    const wrapped = (await client.request("session/compact", {
      sessionId,
      keep,
    })) as {
      result?: {
        messageCountBefore?: number;
        messageCountAfter?: number;
        droppedCount?: number;
      };
      messageCountBefore?: number;
      messageCountAfter?: number;
      droppedCount?: number;
    };
    const r = wrapped.result ?? wrapped;
    const out = {
      messageCountBefore: r.messageCountBefore ?? 0,
      messageCountAfter: r.messageCountAfter ?? 0,
      droppedCount: r.droppedCount ?? 0,
    };
    void this.refreshContext();
    return out;
  }

  /** Wave 2 — one-level listing under the active session cwd. */
  async listFs(path?: string): Promise<
    Array<{ name: string; path: string; kind: "file" | "dir" }>
  > {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    const res = (await client.request("workspace/fs/list", {
      sessionId,
      ...(path !== undefined ? { path } : {}),
    })) as {
      entries?: Array<{ name: string; path: string; kind: "file" | "dir" }>;
    };
    return res.entries ?? [];
  }

  /** Wave 2 — read a text file under the session cwd. */
  async readFs(
    path: string,
    maxBytes?: number,
  ): Promise<{
    path: string;
    text?: string;
    truncated?: boolean;
    mime?: string;
    binary?: boolean;
  }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    return (await client.request("workspace/fs/read", {
      sessionId,
      path,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    })) as {
      path: string;
      text?: string;
      truncated?: boolean;
      mime?: string;
      binary?: boolean;
    };
  }

  /** Wave 2 — write under `{cwd}/.envoy-attachments/`. */
  async attachFile(input: {
    name: string;
    dataBase64: string;
    mimeType?: string;
  }): Promise<{ relativePath: string; path: string; bytes: number }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    return (await client.request("workspace/attach", {
      sessionId,
      name: input.name,
      dataBase64: input.dataBase64,
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
    })) as { relativePath: string; path: string; bytes: number };
  }

  /** Wave 3 — subscribe to PTY output notifications. */
  subscribeTerminalOutput(listener: TerminalOutputListener): () => void {
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  async openTerminal(opts?: {
    cwd?: string;
    name?: string;
  }): Promise<{ terminalId: string; type: string; motd: string }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    return (await client.request("session/terminal/open", {
      sessionId,
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.name !== undefined ? { name: opts.name } : {}),
    })) as { terminalId: string; type: string; motd: string };
  }

  async writeTerminal(
    terminalId: string,
    data: string,
    submit = true,
  ): Promise<{ viewport: string }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    return (await client.request("session/terminal/write", {
      sessionId,
      terminalId,
      data,
      submit,
    })) as { viewport: string };
  }

  async readTerminal(terminalId: string): Promise<{ text: string }> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    return (await client.request("session/terminal/read", {
      sessionId,
      terminalId,
    })) as { text: string };
  }

  async closeTerminal(terminalId: string): Promise<boolean> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    const res = (await client.request("session/terminal/close", {
      sessionId,
      terminalId,
    })) as { closed?: boolean };
    return res.closed === true;
  }

  /** Project registry: `[]` when not connected. */
  async listWorkspaces(): Promise<WorkspaceEntry[]> {
    return await requestWorkspaces(this.#client);
  }

  /** Register a project directory (server rejects non-directories). */
  async addWorkspace(path: string, name?: string): Promise<WorkspaceEntry> {
    return await requestAddWorkspace(this.#client, path, name);
  }

  /** Forget a project; this never deletes the directory. */
  async removeWorkspace(path: string): Promise<boolean> {
    return await requestRemoveWorkspace(this.#client, path);
  }

  /** Steer a background child. A settled child returns a structured miss. */
  async sendAgentMessage(
    agentId: string,
    message: string,
  ): Promise<AgentMessageResult> {
    return await requestAgentMessage(
      this.#client,
      this.#state.sessionId,
      agentId,
      message,
    );
  }

  /** Interrupt a background child's current turn (it stays alive). */
  async interruptAgent(
    agentId: string,
    reason?: string,
  ): Promise<AgentInterruptResult> {
    return await requestAgentInterrupt(
      this.#client,
      this.#state.sessionId,
      agentId,
      reason,
    );
  }

  /**
   * M1 — soft-switch to another open session without cancelling its (or the
   * previous) in-flight turn. Warm tabs restore from cache; cold tabs load.
   */
  async switchSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    if (sessionId === this.#state.sessionId) return;
    this.#snapshotActiveCache();
    if (
      this.#warmSessions.has(sessionId) &&
      this.#sessionCaches.has(sessionId)
    ) {
      writeLastSessionId(sessionId);
      this.#restoreCache(sessionId);
      void this.refreshContext();
      return;
    }
    await this.#loadSessionIntoView(sessionId);
  }

  /** Sidebar / cold open — load from disk; does not cancel other tabs. */
  async resumeSession(sessionId: string): Promise<void> {
    this.#snapshotActiveCache();
    await this.#loadSessionIntoView(sessionId);
  }

  async #loadSessionIntoView(sessionId: string): Promise<void> {
    const client = this.#client;
    if (!client) throw new Error("not connected");

    // Do not cancel other sessions — M1 parallel tabs.
    this.#clearPendingHostRequests("session resumed");

    const res = (await client.request("session/load", {
      sessionId,
    })) as {
      sessionId: string;
      messages?: Array<{
        role?: string;
        text?: string;
      }>;
    };
    const hydrated =
      res.messages
        ?.filter((m) => m.text && m.text.trim().length > 0)
        .map((m) => {
          const roleRaw = m.role ?? "system";
          const role: ChatRole =
            roleRaw === "user" ||
            roleRaw === "assistant" ||
            roleRaw === "tool" ||
            roleRaw === "system" ||
            roleRaw === "status"
              ? roleRaw
              : "system";
          return {
            id: nextMsgId(),
            role,
            text: m.text!,
            at: Date.now(),
          };
        }) ?? [];
    const messages =
      hydrated.length > 0
        ? hydrated
        : [
            {
              id: nextMsgId(),
              role: "system" as const,
              text: `Resumed session ${res.sessionId} (no transcript rows returned).`,
              at: Date.now(),
            },
          ];
    writeLastSessionId(res.sessionId);
    this.#warmSessions.add(res.sessionId);
    this.#sessionCaches.set(res.sessionId, {
      messages,
      cwd: this.#state.cwd,
      changedFiles: [],
      turnHints: null,
      contextStats: null,
      slashCatalog: null,
    });
    this.#patch({
      sessionId: res.sessionId,
      messages,
      error: null,
      busy: this.#busySessions.has(res.sessionId),
      permission: null,
      userQuestion: null,
      slashCatalog: null,
      contextStats: null,
      changedFiles: [],
      turnHints: null,
    });
    void this.refreshMesh();
    void this.refreshContext();
  }

  /**
   * Start a fresh ACP session (clears the local transcript). When `cwd` is
   * a non-empty path the session is created there; otherwise the server
   * default working directory is used.
   */
  async newSession(cwd?: string): Promise<void> {
    const client = this.#client;
    if (!client || client.closed) throw new Error("not connected");

    if (this.#state.busy && this.#state.sessionId) {
      try {
        await client.request("session/cancel", {
          sessionId: this.#state.sessionId,
        });
      } catch {
        // best-effort
      }
    }
    this.#clearPendingHostRequests("new session");

    const params = sessionNewParams(cwd);
    const session = (await client.request("session/new", params)) as {
      sessionId: string;
    };
    writeLastSessionId(session.sessionId);
    this.#warmSessions.add(session.sessionId);
    this.#sessionCaches.set(session.sessionId, {
      messages: [],
      cwd: params.cwd ?? this.#state.cwd,
      changedFiles: [],
      turnHints: null,
      contextStats: null,
      slashCatalog: null,
    });
    this.#patch({
      sessionId: session.sessionId,
      // `session/new` does not echo the cwd; the requested project is the
      // best available value until the next bootstrap/config refresh.
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      messages: [],
      error: null,
      busy: false,
      permission: null,
      userQuestion: null,
      slashCatalog: null,
      contextStats: null,
      changedFiles: [],
      turnHints: null,
    });
    void this.refreshMesh();
    void this.refreshContext();
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.#client || this.#client.closed) {
      throw new Error("not connected");
    }
    return this.#client.request(method, params);
  }

  onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void {
    if (!this.#client) return () => undefined;
    return this.#client.onNotification(method, handler);
  }

  close(): void {
    this.#disposed = true;
    this.#autoRetry = false;
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#stopMeshPoll();
    this.#clearPendingHostRequests("host closed");
    this.#generation += 1;
    this.#client?.close();
    this.#client = undefined;
    this.#patch({
      connectionState: "disconnected",
      ready: false,
      busy: false,
    });
  }
}
