/**
 * High-level ACP host over the browser WebSocket JSON-RPC client.
 *
 * Connection recovery follows deepseek-harness patterns: exponential
 * backoff, manual reconnect(), and an explicit connectionState.
 */

import { formatActivityLine, type ActivityLike } from "./activity.js";
import {
  connectAcpWs,
  type WsJsonRpcClient,
} from "./ws-jsonrpc.js";

export type ChatRole = "user" | "assistant" | "system" | "tool" | "status";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
}

export interface PermissionPrompt {
  sessionId: string;
  toolName: string;
  description: string;
  args: unknown;
  resolve: (decision: "allow" | "deny") => void;
}

export interface UserQuestionPrompt {
  sessionId: string;
  question: string;
  options?: string[];
  resolve: (answer: {
    value: string;
    optionIndex?: number;
    cancelled?: boolean;
  }) => void;
}

export interface SessionSummary {
  id: string;
  mtimeMs: number;
  title?: string;
  cwd?: string;
  startedAt?: string;
  messageCount: number;
}

export interface MeshSnapshot {
  connected: number;
  peerTotal: number;
  failed: number;
  peers: Array<{ id: string; ok: boolean; model?: string; error?: string }>;
  teamJobsRunning: number;
  teamJobsTotal: number;
  agentsSummary: string;
  lastDiscovery?: string;
}

export interface AcpHostState {
  connectionState: ConnectionState;
  ready: boolean;
  busy: boolean;
  sessionId: string | null;
  protocolVersion: number | null;
  model: string;
  provider: string;
  sandbox: string;
  approval: string;
  autoRun: string;
  peerCount: number;
  mesh: MeshSnapshot | null;
  cwd: string;
  messages: ChatMessage[];
  error: string | null;
  retryAttempt: number;
  permission: PermissionPrompt | null;
  userQuestion: UserQuestionPrompt | null;
}

type Listener = () => void;

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

export class AcpHost {
  #client: WsJsonRpcClient | undefined;
  #listeners = new Set<Listener>();
  #disposed = false;
  #connecting = false;
  #autoRetry = true;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #meshTimer: ReturnType<typeof setInterval> | undefined;
  #retryAttempt = 0;
  #generation = 0;
  #state: AcpHostState = {
    connectionState: "idle",
    ready: false,
    busy: false,
    sessionId: null,
    protocolVersion: null,
    model: "",
    provider: "",
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

    let connected = 0;
    let peerTotal = 0;
    let failed = 0;
    let peers: MeshSnapshot["peers"] = [];
    try {
      const res = (await client.request("cluster/status", {})) as {
        cluster?: {
          connected?: number;
          failed?: number;
          peers?: Array<{
            id: string;
            model?: string;
            health?: { ok?: boolean; error?: string };
          }>;
        };
      };
      const c = res.cluster;
      if (c) {
        connected = c.connected ?? 0;
        failed = c.failed ?? 0;
        peers = (c.peers ?? []).map((p) => ({
          id: p.id,
          ok: p.health?.ok !== false,
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.health?.error !== undefined ? { error: p.health.error } : {}),
        }));
        peerTotal = peers.length;
      }
    } catch {
      try {
        const res = (await client.request("peers/list", {})) as {
          peers?: Array<{ id: string; model?: string }>;
        };
        peers = (res.peers ?? []).map((p) => ({
          id: p.id,
          ok: true,
          ...(p.model !== undefined ? { model: p.model } : {}),
        }));
        peerTotal = peers.length;
        connected = peerTotal;
      } catch {
        // keep previous
      }
    }

    let teamJobsRunning = 0;
    let teamJobsTotal = 0;
    try {
      const res = (await client.request("team/jobs", {})) as {
        jobs?: Array<{ status?: string }>;
      };
      const jobs = res.jobs ?? [];
      teamJobsTotal = jobs.length;
      teamJobsRunning = jobs.filter((j) => j.status === "running").length;
    } catch {
      // optional
    }

    let agentsSummary = "";
    try {
      const res = (await client.request("session/agents", {
        sessionId,
      })) as { output?: string };
      agentsSummary = (res.output ?? "").trim();
    } catch {
      agentsSummary = "";
    }

    const mesh: MeshSnapshot = {
      connected,
      peerTotal,
      failed,
      peers,
      teamJobsRunning,
      teamJobsTotal,
      agentsSummary,
      ...(this.#state.mesh?.lastDiscovery !== undefined
        ? { lastDiscovery: this.#state.mesh.lastDiscovery }
        : {}),
    };
    this.#patch({ mesh, peerCount: connected });
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
    this.#patch({
      connectionState: "connecting",
      ready: false,
      busy: false,
      sessionId: null,
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
        };
        const answer = await new Promise<{
          value: string;
          optionIndex?: number;
          cancelled?: boolean;
        }>((resolve) => {
          this.#patch({
            userQuestion: {
              sessionId: req.sessionId,
              question: req.question ?? req.prompt ?? "Question",
              ...(req.options !== undefined ? { options: req.options } : {}),
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
      const p = params as {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
        text?: string;
        toolName?: string;
      };
      if (p.sessionUpdate === "agent_message_chunk" || p.content?.text) {
        const text = p.content?.text ?? p.text ?? "";
        if (text) this.#appendAssistantChunk(text);
      } else if (p.toolName) {
        this.#pushMessage("tool", `tool: ${p.toolName}`);
      }
    });

    client.onNotification("session/activity", (params) => {
      if (!this.#state.busy) return;
      const p = params as {
        sessionId?: string;
        activity?: ActivityLike;
      };
      if (
        p.sessionId !== undefined &&
        this.#state.sessionId !== null &&
        p.sessionId !== this.#state.sessionId
      ) {
        return;
      }
      if (p.activity === undefined) return;
      if (p.activity.kind === "model_response") return;
      if (p.activity.kind === "tool_result" && p.activity.isError !== true) {
        return;
      }
      if (p.activity.kind === "agent_start") return;
      const line = formatActivityLine(p.activity);
      if (line) this.#pushMessage("status", line);
      // Refresh mesh when sub-agents start/end.
      if (
        p.activity.kind === "agent_end" ||
        p.activity.subagentOf !== undefined
      ) {
        void this.refreshMesh();
      }
    });

    client.onNotification("session/token", (params) => {
      const p = params as { model?: string };
      if (p.model) this.#patch({ model: p.model });
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
    const init = (await client.request("initialize", {})) as {
      protocolVersion: number;
    };
    const session = (await client.request("session/new", {})) as {
      sessionId: string;
    };

    // Best-effort discovery subscription (Trace panel + mesh rail).
    try {
      await client.request("discovery/subscribe", {});
    } catch {
      // host may not support discovery
    }

    let config: Record<string, unknown> = {};
    try {
      config = (await client.request("config/get", {})) as Record<
        string,
        unknown
      >;
    } catch {
      // optional
    }

    let policy = {
      sandbox: "read-only",
      approval: "on-request",
      autoRun: "always-confirm",
    };
    try {
      const res = (await client.request("session/get_policy", {
        sessionId: session.sessionId,
      })) as {
        result?: { sandbox?: string; approval?: string; autoRun?: string };
      };
      policy = {
        sandbox: res.result?.sandbox ?? policy.sandbox,
        approval: res.result?.approval ?? policy.approval,
        autoRun: res.result?.autoRun ?? policy.autoRun,
      };
    } catch {
      // optional
    }

    this.#patch({
      sessionId: session.sessionId,
      protocolVersion: init.protocolVersion,
      provider: String(config["provider"] ?? ""),
      model: String(config["model"] ?? ""),
      sandbox: policy.sandbox,
      approval: policy.approval,
      autoRun: policy.autoRun,
      cwd: String(config["cwd"] ?? ""),
      messages: [],
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

  async prompt(text: string): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId || !this.#state.ready) {
      throw new Error("not connected");
    }
    this.#pushMessage("user", text);
    this.#patch({ busy: true, error: null });
    try {
      const res = (await client.request("session/prompt", {
        sessionId,
        text,
      })) as {
        stopReason?: string;
        messages?: Array<{ role?: string; text?: string }>;
      };
      const assistantTexts =
        res.messages
          ?.filter((m) => m.role === "assistant" && m.text)
          .map((m) => m.text!) ?? [];
      if (assistantTexts.length > 0) {
        const combined = assistantTexts.join("\n");
        const last = this.#state.messages[this.#state.messages.length - 1];
        if (!(last?.role === "assistant")) {
          this.#pushMessage("assistant", combined);
        }
      }
      void this.refreshMesh();
    } catch (err) {
      this.#patch({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.#patch({ busy: false });
    }
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

  async setModel(provider: string, model: string): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    try {
      const res = (await client.request("session/set_model", {
        sessionId,
        provider,
        ...(model ? { model } : {}),
      })) as { result?: { provider?: string; model?: string } };
      this.#patch({
        provider: res.result?.provider ?? provider,
        model: res.result?.model ?? model,
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

  async listSessions(): Promise<SessionSummary[]> {
    const client = this.#client;
    if (!client) return [];
    const res = (await client.request("sessions/list", {})) as {
      sessions: SessionSummary[];
    };
    return res.sessions ?? [];
  }

  async resumeSession(sessionId: string): Promise<void> {
    const client = this.#client;
    if (!client) throw new Error("not connected");
    const res = (await client.request("session/load", {
      sessionId,
    })) as { sessionId: string };
    this.#patch({
      sessionId: res.sessionId,
      messages: [
        {
          id: nextMsgId(),
          role: "system",
          text:
            `Resumed session ${res.sessionId}. ` +
            `Prior turns live in the agent context (transcript view is this UI session).`,
          at: Date.now(),
        },
      ],
      error: null,
    });
    void this.refreshMesh();
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
