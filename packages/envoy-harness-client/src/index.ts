/**
 * @envoymesh/envoy-harness-client — typed stdio client for
 * the ACP + embedding SDK dialects.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { JsonRpcConnection } from "@envoymesh/envoy-harness";
import type {
  ClientClusterStatus,
  ClientDiscoveryEvent,
  ClientPeerInfo,
  ClientScoreboardEntry,
  ClientSessionSummary,
  ClientTeamJob,
  EhuiDataSource,
} from "./ehui.js";

export type {
  ClientClusterStatus,
  ClientDiscoveryEvent,
  ClientPeerInfo,
  ClientScoreboardEntry,
  ClientSessionSummary,
  ClientTeamJob,
  EhuiDataSource,
  EhuiPanelId,
} from "./ehui.js";
export { EHUI_PANELS } from "./ehui.js";

export interface EnvoyHarnessClientOptions {
  input: Readable;
  output: Writable;
  onPermissionRequest?: (req: {
    sessionId: string;
    toolName: string;
    description: string;
    args: unknown;
  }) => Promise<"allow" | "deny">;
  onEvent?: (event: { dialect: "acp" | "sdk"; params: unknown }) => void;
}

export class EnvoyHarnessClient {
  readonly #conn: JsonRpcConnection;
  readonly #onEvent: EnvoyHarnessClientOptions["onEvent"];
  readonly #notificationHandlers = new Map<
    string,
    Set<(params: unknown) => void>
  >();
  #dialect: "acp" | "sdk" | undefined;

  constructor(options: EnvoyHarnessClientOptions) {
    this.#onEvent = options.onEvent;
    this.#conn = new JsonRpcConnection({
      input: options.input,
      output: options.output,
      onRequest: async (method, params) => {
        if (method === "session/request_permission") {
          const req = params as {
            sessionId: string;
            toolName: string;
            description: string;
            args: unknown;
          };
          const decision =
            (await options.onPermissionRequest?.(req)) ?? "deny";
          return { decision };
        }
        throw new Error(`unexpected server request: ${method}`);
      },
      onNotification: (method, params) => {
        const handlers = this.#notificationHandlers.get(method);
        if (handlers !== undefined) {
          for (const handler of [...handlers]) handler(params);
        }
        if (method === "session/update") {
          this.#onEvent?.({ dialect: "acp", params });
        } else if (method === "session/event") {
          this.#onEvent?.({ dialect: "sdk", params });
        }
      },
    });
  }

  /** Register a notification handler; returns an unsubscribe fn. */
  onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void {
    let set = this.#notificationHandlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.#notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.#notificationHandlers.delete(method);
    };
  }

  async initialize(): Promise<{
    protocolVersion: number;
    capabilities?: {
      promptCapabilities?: { image?: boolean };
    };
  }> {
    this.#dialect = "acp";
    return (await this.#conn.request("initialize", {})) as {
      protocolVersion: number;
      capabilities?: {
        promptCapabilities?: { image?: boolean };
      };
    };
  }

  async acpNewSession(params?: {
    cwd?: string;
  }): Promise<{ sessionId: string }> {
    this.#dialect = "acp";
    return (await this.#conn.request("session/new", params ?? {})) as {
      sessionId: string;
    };
  }

  async loadSession(
    sessionId: string,
    cwd?: string,
  ): Promise<{ sessionId: string }> {
    this.#dialect = "acp";
    return (await this.#conn.request("session/load", {
      sessionId,
      ...(cwd !== undefined ? { cwd } : {}),
    })) as { sessionId: string };
  }

  /** U6a.5 — list persisted sessions (`sessions/list`). */
  async listSessions(): Promise<ClientSessionSummary[]> {
    const res = (await this.#conn.request("sessions/list", {})) as {
      sessions: ClientSessionSummary[];
    };
    return res.sessions;
  }

  async createSession(params?: {
    cwd?: string;
  }): Promise<{ sessionId: string }> {
    this.#dialect = "sdk";
    return (await this.#conn.request("session/create", params ?? {})) as {
      sessionId: string;
    };
  }

  async prompt(
    sessionId: string,
    text: string,
    content?: ReadonlyArray<
      { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
    >,
  ): Promise<{ stopReason: string; messages: unknown[] }> {
    return (await this.#conn.request("session/prompt", {
      sessionId,
      ...(content !== undefined && content.length > 0 ? { content } : { text }),
    })) as { stopReason: string; messages: unknown[] };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#conn.request("session/cancel", { sessionId });
  }

  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const res = (await this.#conn.request("tools/list", {})) as {
      tools: Array<{ name: string; description: string }>;
    };
    return res.tools;
  }

  async getConfig(): Promise<Record<string, unknown>> {
    return (await this.#conn.request("config/get", {})) as Record<
      string,
      unknown
    >;
  }

  /** R3 — the host's connected peer cluster (`peers/list`, both dialects). */
  async listPeers(): Promise<ClientPeerInfo[]> {
    const res = (await this.#conn.request("peers/list", {})) as {
      peers: ClientPeerInfo[];
    };
    return res.peers;
  }

  /** U1 — the host's cluster status (`cluster/status`, both dialects). */
  async clusterStatus(): Promise<ClientClusterStatus> {
    const res = (await this.#conn.request("cluster/status", {})) as {
      cluster: ClientClusterStatus;
    };
    return res.cluster;
  }

  /** U1 — the host's team jobs (`team/jobs`, both dialects). */
  async teamJobs(): Promise<ClientTeamJob[]> {
    const res = (await this.#conn.request("team/jobs", {})) as {
      jobs: ClientTeamJob[];
    };
    return res.jobs;
  }

  /** U1 — the host's peer reputation scoreboard (`scoreboard/summary`). */
  async scoreboardSummary(): Promise<ClientScoreboardEntry[]> {
    const res = (await this.#conn.request("scoreboard/summary", {})) as {
      entries: ClientScoreboardEntry[];
    };
    return res.entries;
  }

  /**
   * U3 — subscribe to discovery/lifecycle events. Returns an
   * unsubscribe function. The server forwards `discovery/event`
   * notifications to `listener`.
   */
  async subscribeDiscovery(
    listener: (event: ClientDiscoveryEvent) => void,
  ): Promise<() => void> {
    // Register the notification handler BEFORE the request so events
    // emitted during subscription (initial replay) are not missed.
    const remove = this.onNotification("discovery/event", (params) => {
      const { event } = (params ?? {}) as { event?: ClientDiscoveryEvent };
      if (event !== undefined) listener(event);
    });
    try {
      const res = (await this.#conn.request("discovery/subscribe", {})) as {
        subscribed: boolean;
      };
      if (!res.subscribed) {
        throw new Error("discovery/subscribe not supported by this host");
      }
      return remove;
    } catch (err) {
      remove();
      throw err;
    }
  }

  /**
   * U3 — routing preview: which peer would run a task with this
   * capability tag (`cluster/route`). Returns undefined when the host
   * has no peer for the tag.
   */
  async routePeer(
    capabilityTag: string,
    preferredPeerId?: string,
  ): Promise<ClientPeerInfo | undefined> {
    const res = (await this.#conn.request("cluster/route", {
      capabilityTag,
      ...(preferredPeerId !== undefined ? { preferredPeerId } : {}),
    })) as { peer: ClientPeerInfo | null };
    return res.peer ?? undefined;
  }

  /** Runtime mesh wiring (`cluster/connect`). */
  async connectClusterPeer(params: {
    id: string;
    endpoint: string;
    model?: string;
    capabilities?: readonly string[];
  }): Promise<{ ok: boolean; error?: string }> {
    return (await this.#conn.request("cluster/connect", {
      id: params.id,
      endpoint: params.endpoint,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.capabilities !== undefined
        ? { capabilities: [...params.capabilities] }
        : {}),
    })) as { ok: boolean; error?: string };
  }

  async compactSession(
    sessionId: string,
    options?: { keep?: number; budget?: number; summarize?: boolean },
  ): Promise<{
    messageCountBefore: number;
    messageCountAfter: number;
    droppedCount: number;
    totalTokensAfter?: number;
    overBudget?: boolean;
    summarized?: boolean;
  }> {
    const res = (await this.#conn.request("session/compact", {
      sessionId,
      ...(options?.keep !== undefined ? { keep: options.keep } : {}),
      ...(options?.budget !== undefined ? { budget: options.budget } : {}),
      ...(options?.summarize === true ? { summarize: true } : {}),
    })) as {
      result: {
        messageCountBefore: number;
        messageCountAfter: number;
        droppedCount: number;
        totalTokensAfter?: number;
        overBudget?: boolean;
        summarized?: boolean;
      };
    };
    return res.result;
  }

  async setSessionModel(
    sessionId: string,
    provider: string,
    model?: string,
  ): Promise<{ provider: string; model?: string }> {
    const res = (await this.#conn.request("session/set_model", {
      sessionId,
      provider,
      ...(model !== undefined ? { model } : {}),
    })) as { result: { provider: string; model?: string } };
    return res.result;
  }

  async setSessionPolicy(
    sessionId: string,
    policy: {
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      approval?: "unless-trusted" | "on-request" | "granular" | "never";
    },
  ): Promise<{ sandbox?: string; approval?: string }> {
    const res = (await this.#conn.request("session/set_policy", {
      sessionId,
      ...(policy.sandbox !== undefined ? { sandbox: policy.sandbox } : {}),
      ...(policy.approval !== undefined ? { approval: policy.approval } : {}),
    })) as { result: { sandbox?: string; approval?: string } };
    return res.result;
  }

  async gitDiff(
    sessionId: string,
    options?: { staged?: boolean; stat?: boolean },
  ): Promise<string> {
    const res = (await this.#conn.request("git/diff", {
      sessionId,
      ...(options?.staged === true ? { staged: true } : {}),
      ...(options?.stat === true ? { stat: true } : {}),
    })) as { output: string };
    return res.output;
  }

  async gitStatus(sessionId: string): Promise<string> {
    const res = (await this.#conn.request("git/status", {
      sessionId,
    })) as { output: string };
    return res.output;
  }

  async getSessionContext(sessionId: string): Promise<{
    messageCount: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }> {
    return (await this.#conn.request("session/context", {
      sessionId,
    })) as {
      messageCount: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    };
  }

  async listSessionHooks(sessionId: string): Promise<
    Array<{ event: string; handlerCount: number }>
  > {
    const res = (await this.#conn.request("session/hooks", {
      sessionId,
    })) as { hooks: Array<{ event: string; handlerCount: number }> };
    return res.hooks;
  }

  async listSessionMcp(sessionId: string): Promise<string[]> {
    const res = (await this.#conn.request("session/mcp", {
      sessionId,
    })) as { servers: string[] };
    return res.servers;
  }

  async listSessionAgents(sessionId: string): Promise<string> {
    const res = (await this.#conn.request("session/agents", {
      sessionId,
    })) as { output: string };
    return res.output;
  }

  async sessionPlan(
    sessionId: string,
    action: string,
    options?: { text?: string; reason?: string },
  ): Promise<string> {
    const res = (await this.#conn.request("session/plan", {
      sessionId,
      action,
      ...(options?.text !== undefined ? { text: options.text } : {}),
      ...(options?.reason !== undefined ? { reason: options.reason } : {}),
    })) as { output: string };
    return res.output;
  }

  async sessionMemory(
    sessionId: string,
    op: "list" | "read" | "add",
    options?: { name?: string; body?: string },
  ): Promise<string> {
    const res = (await this.#conn.request("session/memory", {
      sessionId,
      op,
      ...(options?.name !== undefined ? { name: options.name } : {}),
      ...(options?.body !== undefined ? { body: options.body } : {}),
    })) as { output: string };
    return res.output;
  }

  async sessionReview(
    sessionId: string,
    staged?: boolean,
  ): Promise<string> {
    const res = (await this.#conn.request("session/review", {
      sessionId,
      ...(staged === true ? { staged: true } : {}),
    })) as { output: string };
    return res.output;
  }

  async sessionInit(sessionId: string): Promise<string> {
    const res = (await this.#conn.request("session/init", {
      sessionId,
    })) as { output: string };
    return res.output;
  }

  get dialect(): "acp" | "sdk" | undefined {
    return this.#dialect;
  }

  close(): void {
    this.#conn.close();
  }
}

/** Create an EHUI data-source for a live session (EnvoyGo side panel). */
export function createEhuiDataSource(
  client: EnvoyHarnessClient,
  sessionId: string,
): EhuiDataSource {
  return {
    sessionId,
    plan: (action, options) => client.sessionPlan(sessionId, action, options),
    memory: (op, options) => client.sessionMemory(sessionId, op, options),
    gitDiff: (options) => client.gitDiff(sessionId, options),
    gitStatus: () => client.gitStatus(sessionId),
    clusterStatus: () => client.clusterStatus(),
    listPeers: () => client.listPeers(),
    teamJobs: () => client.teamJobs(),
    scoreboardSummary: () => client.scoreboardSummary(),
    listSessions: () => client.listSessions(),
    subscribeDiscovery: (listener) => client.subscribeDiscovery(listener),
  };
}

export { JsonRpcConnection };

export interface SpawnAcpOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stderr?: "inherit" | "pipe" | "ignore";
  onPermissionRequest?: EnvoyHarnessClientOptions["onPermissionRequest"];
  onEvent?: EnvoyHarnessClientOptions["onEvent"];
}

export interface SpawnedAcp {
  client: EnvoyHarnessClient;
  child: ChildProcessWithoutNullStreams;
  close(): void;
}

/** Spawn a harness ACP server and return a typed client over its stdio. */
export function spawnAcpServer(options: SpawnAcpOptions = {}): SpawnedAcp {
  const command = options.command ?? "envoy-harness";
  const args = options.args ?? ["--acp"];
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", options.stderr ?? "inherit"],
  }) as ChildProcessWithoutNullStreams;

  const client = new EnvoyHarnessClient({
    input: child.stdout,
    output: child.stdin,
    ...(options.onPermissionRequest !== undefined
      ? { onPermissionRequest: options.onPermissionRequest }
      : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
  });

  return {
    client,
    child,
    close() {
      client.close();
      if (!child.killed) child.kill();
    },
  };
}
