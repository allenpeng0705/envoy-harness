/**
 * @envoymesh/envoy-harness-client — typed stdio client for
 * the ACP + embedding SDK dialects.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { JsonRpcConnection } from "@envoymesh/envoy-harness";

export interface ClientPeerInfo {
  id: string;
  model?: string;
  capabilities?: readonly string[];
}

/** U1 — cluster status (peers + health) for the dedicated UI. */
export interface ClientClusterStatus {
  peers: Array<{
    id: string;
    model?: string;
    capabilities?: readonly string[];
    health: { ok: boolean; rttMs?: number; lastPingAt?: string; error?: string };
  }>;
  connected: number;
  failed: number;
}

/** U1 — one team job (agents + status) for the dedicated UI. */
export interface ClientTeamJob {
  jobId: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  costUsd?: number;
  agents: Array<{
    id: string;
    host: string;
    model?: string;
    status: "pending" | "running" | "completed" | "failed";
    costUsd?: number;
    startedAt?: string;
    completedAt?: string;
  }>;
}

/** U1 — one scoreboard entry (reputation per peer+skill). */
export interface ClientScoreboardEntry {
  workerPeerId: string;
  skillId: string;
  score: number;
  passCount: number;
  failCount: number;
  partialCount: number;
}

/** U3 — one discovery/lifecycle event (`discovery/event`). */
export interface ClientDiscoveryEvent {
  type: "peer.connected" | "peer.disconnected" | "peer.failed" | "peer.health";
  peerId: string;
  model?: string;
  rttMs?: number;
  error?: string;
  at: string;
}

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

  async initialize(): Promise<{ protocolVersion: number }> {
    this.#dialect = "acp";
    return (await this.#conn.request("initialize", {})) as {
      protocolVersion: number;
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
  ): Promise<{ stopReason: string; messages: unknown[] }> {
    return (await this.#conn.request("session/prompt", {
      sessionId,
      text,
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

  get dialect(): "acp" | "sdk" | undefined {
    return this.#dialect;
  }

  close(): void {
    this.#conn.close();
  }
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
