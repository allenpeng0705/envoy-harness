/**
 * Browser-safe EHUI types + panel catalog (no Node / envoy-harness imports).
 * EnvoyMesh Social and @envoymesh/envoy-harness-ehui import this entry only.
 */

export interface ClientPeerInfo {
  id: string;
  /** Advertised model id (routing), when known. */
  model?: string;
  capabilities?: readonly string[];
  /** `"host:port"` TCP endpoint when the host knows it (standalone peers). */
  endpoint?: string;
}

export interface ClientClusterStatus {
  peers: Array<{
    id: string;
    model?: string;
    capabilities?: readonly string[];
    endpoint?: string;
    health: { ok: boolean; rttMs?: number; lastPingAt?: string; error?: string };
  }>;
  connected: number;
  failed: number;
}

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

export interface ClientScoreboardEntry {
  workerPeerId: string;
  skillId: string;
  score: number;
  passCount: number;
  failCount: number;
  partialCount: number;
}

export interface ClientSessionSummary {
  id: string;
  mtimeMs: number;
  title?: string;
  cwd?: string;
  startedAt?: string;
  messageCount: number;
}

export interface ClientDiscoveryEvent {
  type: "peer.connected" | "peer.disconnected" | "peer.failed" | "peer.health";
  peerId: string;
  model?: string;
  rttMs?: number;
  error?: string;
  at: string;
}

export const EHUI_PANELS = [
  { id: "chat", label: "Chat", kind: "session" as const },
  { id: "plan", label: "Plan", method: "session/plan" as const },
  { id: "memory", label: "Memory", method: "session/memory" as const },
  { id: "git-diff", label: "Diff", method: "git/diff" as const },
  { id: "git-status", label: "Status", method: "git/status" as const },
  { id: "mesh", label: "Mesh", method: "cluster/status" as const },
  { id: "peers", label: "Peers", method: "peers/list" as const },
  { id: "cluster", label: "Cluster", method: "cluster/status" as const },
  { id: "team", label: "Team", method: "team/jobs" as const },
  { id: "scoreboard", label: "Scoreboard", method: "scoreboard/summary" as const },
  {
    id: "trace",
    label: "Trace",
    notification: "discovery/event" as const,
  },
  { id: "resume", label: "Sessions", method: "sessions/list" as const },
] as const;

export type EhuiPanelId = (typeof EHUI_PANELS)[number]["id"];

export interface EhuiDataSource {
  readonly sessionId: string;
  plan(
    action: string,
    options?: { text?: string; reason?: string },
  ): Promise<string>;
  memory(
    op: "list" | "read" | "add",
    options?: { name?: string; body?: string },
  ): Promise<string>;
  gitDiff(options?: { staged?: boolean; stat?: boolean }): Promise<string>;
  gitStatus(): Promise<string>;
  clusterStatus(): Promise<ClientClusterStatus>;
  listPeers(): Promise<ClientPeerInfo[]>;
  /**
   * Peers with a known TCP endpoint (for Mesh onboarding / config display).
   * Distinct from live health (`clusterStatus`) — only returns rows that
   * include a non-empty `endpoint`.
   */
  listConfiguredPeers(): Promise<Array<{ id: string; endpoint: string }>>;
  teamJobs(): Promise<ClientTeamJob[]>;
  scoreboardSummary(): Promise<ClientScoreboardEntry[]>;
  listSessions(): Promise<ClientSessionSummary[]>;
  subscribeDiscovery(
    listener: (event: ClientDiscoveryEvent) => void,
  ): Promise<() => void>;
}
