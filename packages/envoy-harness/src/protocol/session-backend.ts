/**
 * Phase E — shared session backend for ACP + SDK dialects.
 */

export interface ProtocolPermissionRequest {
  sessionId: string;
  toolName: string;
  description: string;
  args: unknown;
}

export type ProtocolPermissionDecision = "allow" | "deny";

export interface ProtocolCommittedMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
}

export interface ProtocolPromptResult {
  stopReason: string;
  messages: ProtocolCommittedMessage[];
}

export interface ProtocolToolInfo {
  name: string;
  description: string;
}

/** One connected peer in the host's peer cluster (R3 peer surface). */
export interface ProtocolPeerInfo {
  id: string;
  model?: string;
  capabilities?: readonly string[];
}

/** U1 — per-peer health snapshot for the cluster rail. */
export interface ProtocolPeerHealth {
  ok: boolean;
  rttMs?: number;
  lastPingAt?: string;
  error?: string;
}

/** U1 — `cluster/status`: the host's peer cluster with health. */
export interface ProtocolClusterStatus {
  peers: Array<{
    id: string;
    model?: string;
    capabilities?: readonly string[];
    health: ProtocolPeerHealth;
  }>;
  connected: number;
  failed: number;
}

/** U1 — one agent inside a `team/jobs` entry. */
export interface ProtocolTeamAgentStatus {
  id: string;
  /** `"local"` or `"peer://<id>"`. */
  host: string;
  model?: string;
  status: "pending" | "running" | "completed" | "failed";
  costUsd?: number;
  startedAt?: string;
  completedAt?: string;
}

/** U1 — `team/jobs`: running/finished distributed team runs. */
export interface ProtocolTeamJob {
  jobId: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  costUsd?: number;
  agents: ProtocolTeamAgentStatus[];
}

/** U1 — `scoreboard/summary`: reputation per (peer, skill). */
export interface ProtocolScoreboardEntry {
  workerPeerId: string;
  skillId: string;
  score: number;
  passCount: number;
  failCount: number;
  partialCount: number;
}

/** U3 — one discovery/lifecycle event pushed to subscribed clients. */
export interface ProtocolDiscoveryEvent {
  type: "peer.connected" | "peer.disconnected" | "peer.failed" | "peer.health";
  peerId: string;
  model?: string;
  rttMs?: number;
  error?: string;
  at: string;
}

export interface ProtocolSessionBackend {
  createSession(params?: { cwd?: string }): Promise<{ sessionId: string }>;
  prompt(params: {
    sessionId: string;
    text: string;
    signal: AbortSignal;
    requestPermission: (
      req: ProtocolPermissionRequest,
    ) => Promise<ProtocolPermissionDecision>;
    onUpdate?: (msg: ProtocolCommittedMessage) => void;
  }): Promise<ProtocolPromptResult>;
  cancel(sessionId: string): void;
  listTools?(): ProtocolToolInfo[];
  getConfig?(): Record<string, unknown>;
  /**
   * R3 — the host's connected peer cluster (static discovery). The
   * standalone harness CLI has no peers of its own; hosts that embed
   * the ACP/SDK server (e.g. EnvoyMesh's in-process ACP host) wire this
   * to their registry so clients can render a `/peers` surface.
   */
  listPeers?(): ReadonlyArray<ProtocolPeerInfo>;
  /**
   * U1 — the host's cluster status (peers + health). Optional: the UI
   * shows "unavailable" when the host doesn't wire it.
   */
  clusterStatus?(): ProtocolClusterStatus | Promise<ProtocolClusterStatus>;
  /** U1 — the host's team jobs (running/finished). Optional. */
  teamJobs?(): ReadonlyArray<ProtocolTeamJob>;
  /** U1 — the host's peer reputation scoreboard. Optional. */
  scoreboardSummary?(): ReadonlyArray<ProtocolScoreboardEntry>;
  /**
   * U3 — subscribe to discovery/lifecycle events. Returns an
   * unsubscribe function (or undefined when the backend doesn't
   * support unsubscribing). The server forwards events to the client
   * as `discovery/event` notifications.
   */
  subscribeDiscovery?(
    listener: (event: ProtocolDiscoveryEvent) => void,
  ): (() => void) | void;
  /**
   * U3 — routing preview: which peer would run a task with this
   * capability tag (and optional preferred peer id). Optional.
   */
  routePeer?(input: {
    capabilityTag: string;
    preferredPeerId?: string;
  }): ProtocolPeerInfo | undefined;
}

/** In-memory backend for hermetic protocol tests. */
export function createFakeSessionBackend(options?: {
  tools?: ProtocolToolInfo[];
  config?: Record<string, unknown>;
  permissionTool?: string;
  peers?: ProtocolPeerInfo[];
  clusterStatus?: ProtocolClusterStatus;
  teamJobs?: ProtocolTeamJob[];
  scoreboard?: ProtocolScoreboardEntry[];
  /** U3 — replayed to each `discovery/subscribe` (for tests). */
  discoveryEvents?: ProtocolDiscoveryEvent[];
  routePeer?: (input: {
    capabilityTag: string;
    preferredPeerId?: string;
  }) => ProtocolPeerInfo | undefined;
}): ProtocolSessionBackend & {
  cancelled: string[];
  prompts: Array<{ sessionId: string; text: string }>;
} {
  let seq = 0;
  const sessions = new Set<string>();
  const aborts = new Map<string, AbortController>();
  const cancelled: string[] = [];
  const prompts: Array<{ sessionId: string; text: string }> = [];
  const tools = options?.tools ?? [
    { name: "bash", description: "Run a shell command" },
  ];

  return {
    cancelled,
    prompts,
    async createSession() {
      const sessionId = `sess-${++seq}`;
      sessions.add(sessionId);
      return { sessionId };
    },
    async prompt(params) {
      if (!sessions.has(params.sessionId)) {
        throw new Error(`unknown session: ${params.sessionId}`);
      }
      prompts.push({ sessionId: params.sessionId, text: params.text });
      const ac = new AbortController();
      aborts.set(params.sessionId, ac);
      const onAbort = (): void => ac.abort();
      params.signal.addEventListener("abort", onAbort, { once: true });

      try {
        if (options?.permissionTool !== undefined) {
          const decision = await params.requestPermission({
            sessionId: params.sessionId,
            toolName: options.permissionTool,
            description: `Allow ${options.permissionTool}?`,
            args: {},
          });
          if (decision === "deny") {
            return {
              stopReason: "permission_denied",
              messages: [{ role: "assistant", text: "permission denied" }],
            };
          }
        }
        if (ac.signal.aborted || params.signal.aborted) {
          return {
            stopReason: "cancelled",
            messages: [{ role: "assistant", text: "cancelled" }],
          };
        }
        const assistant: ProtocolCommittedMessage = {
          role: "assistant",
          text: `echo:${params.text}`,
        };
        params.onUpdate?.(assistant);
        return {
          stopReason: "end_turn",
          messages: [
            { role: "user", text: params.text },
            assistant,
          ],
        };
      } finally {
        params.signal.removeEventListener("abort", onAbort);
        aborts.delete(params.sessionId);
      }
    },
    cancel(sessionId) {
      cancelled.push(sessionId);
      aborts.get(sessionId)?.abort();
    },
    listTools: () => tools,
    getConfig: () => options?.config ?? { version: "0.0.0" },
    ...(options?.peers !== undefined
      ? { listPeers: () => options.peers ?? [] }
      : {}),
    ...(options?.clusterStatus !== undefined
      ? { clusterStatus: () => options.clusterStatus ?? emptyClusterStatus() }
      : {}),
    ...(options?.teamJobs !== undefined
      ? { teamJobs: () => options.teamJobs ?? [] }
      : {}),
    ...(options?.scoreboard !== undefined
      ? { scoreboardSummary: () => options.scoreboard ?? [] }
      : {}),
    ...(options?.discoveryEvents !== undefined
      ? {
          subscribeDiscovery: (
            listener: (event: ProtocolDiscoveryEvent) => void,
          ) => {
            for (const event of options.discoveryEvents ?? []) listener(event);
            return () => undefined;
          },
        }
      : {}),
    ...(options?.routePeer !== undefined
      ? { routePeer: options.routePeer }
      : {}),
  };
}

function emptyClusterStatus(): ProtocolClusterStatus {
  return { peers: [], connected: 0, failed: 0 };
}
