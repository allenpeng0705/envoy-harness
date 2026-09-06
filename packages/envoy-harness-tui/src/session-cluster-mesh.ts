/**
 * Cluster mesh, discovery, and routing display helpers.
 */

import type {
  ClientClusterStatus,
  ClientDiscoveryEvent,
  ClientPeerInfo,
  ClientScoreboardEntry,
  ClientTeamJob,
} from "@envoymesh/envoy-harness-client";
import { parsePeerEndpoint } from "@envoymesh/envoy-harness";

import type { SessionClusterCtx, SessionSink } from "./session-context.js";
import { formatTranscriptLine } from "./transcript.js";

/** R3 — render the host's connected peer cluster (`peers/list`). */
export async function listPeersImpl(s: SessionSink): Promise<void> {
  let peers;
  try {
    peers = await s.client.listPeers();
  } catch (err) {
    s.push("status", `peers unavailable: ${(err as Error).message}`);
    return;
  }
  if (peers.length === 0) {
    s.push("status", "Peers (0) — no peers connected");
    return;
  }
  const lines = peers.map((p) => {
    const model = p.model !== undefined ? ` model=${p.model}` : "";
    const caps =
      p.capabilities !== undefined && p.capabilities.length > 0
        ? ` capabilities=${p.capabilities.join(",")}`
        : "";
    return `- ${p.id}${model}${caps}`;
  });
  s.push("status", `Peers (${peers.length})\n${lines.join("\n")}`);
}

/** U2 — refresh the cluster snapshot (`cluster/status`); best-effort. */
export async function refreshClusterImpl(
  s: SessionClusterCtx,
): Promise<ClientClusterStatus | undefined> {
  try {
    s.clusterSnapshot = await s.client.clusterStatus();
  } catch {
    // Keep the previous snapshot (or undefined); the UI shows the rail
    // only when a snapshot exists.
  }
  return s.clusterSnapshot;
}

/** `/mesh connect <id@host:port>` — runtime peer wiring. */
export async function connectMeshPeerImpl(
  s: SessionClusterCtx,
  raw: string,
): Promise<void> {
  let spec: { id: string; endpoint: string };
  try {
    spec = parsePeerEndpoint(raw);
  } catch (err) {
    s.push(
      "status",
      `mesh connect: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  try {
    const result = await s.client.connectClusterPeer({
      id: spec.id,
      endpoint: spec.endpoint,
    });
    if (result.ok) {
      s.push("status", `mesh: connected ${spec.id}@${spec.endpoint}`);
      await refreshClusterImpl(s);
    } else {
      s.push(
        "status",
        `mesh connect failed: ${result.error ?? "unknown error"}`,
      );
    }
  } catch (err) {
    s.push(
      "status",
      `mesh connect unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** U2 — the host's model label from `config/get` (best-effort). */
export async function getModelLabelImpl(
  s: SessionSink,
): Promise<string | undefined> {
  try {
    const config = await s.client.getConfig();
    const model = (config as { model?: unknown }).model;
    return typeof model === "string" && model.length > 0 ? model : undefined;
  } catch {
    return undefined;
  }
}

/** U3 — buffer one discovery event (the UI renders it as a ticker). */
export function noteDiscoveryEventImpl(
  s: SessionClusterCtx,
  event: ClientDiscoveryEvent,
): void {
  s.discoveryEvents.push(event);
  if (s.discoveryEvents.length > 20) {
    s.discoveryEvents.splice(0, s.discoveryEvents.length - 20);
  }
}

/** U3 — subscribe to the host's discovery stream; returns unsubscribe. */
export async function subscribeDiscoveryImpl(
  s: SessionClusterCtx,
  onEvent?: () => void,
): Promise<() => void> {
  const remove = await s.client.subscribeDiscovery((event) => {
    noteDiscoveryEventImpl(s, event);
    onEvent?.();
  });
  return remove;
}

/** U3 — routing preview (plain mode renders it as a status line). */
export async function showRouteImpl(
  s: SessionSink,
  tag: string,
): Promise<void> {
  let peer;
  try {
    peer = await s.client.routePeer(tag);
  } catch (err) {
    s.push("status", `route unavailable: ${(err as Error).message}`);
    return;
  }
  if (peer === undefined) {
    s.push("status", `Route "${tag}" → no peer available`);
    return;
  }
  const model = peer.model !== undefined ? ` model=${peer.model}` : "";
  const caps =
    peer.capabilities !== undefined && peer.capabilities.length > 0
      ? ` capabilities=${peer.capabilities.join(",")}`
      : "";
  s.push("status", `Route "${tag}" → ${peer.id}${model}${caps}`);
}

export async function peersImpl(s: SessionSink): Promise<ClientPeerInfo[]> {
  return s.client.listPeers();
}

export async function teamJobsImpl(s: SessionSink): Promise<ClientTeamJob[]> {
  return s.client.teamJobs();
}

export async function scoreboardImpl(
  s: SessionSink,
): Promise<ClientScoreboardEntry[]> {
  return s.client.scoreboardSummary();
}

export async function routeImpl(
  s: SessionSink,
  tag: string,
): Promise<ClientPeerInfo | undefined> {
  return s.client.routePeer(tag);
}

/** U5 — plain-mode `/search`: list matching transcript lines. */
export async function showSearchImpl(
  s: SessionClusterCtx,
  term: string,
): Promise<void> {
  const matches = s.lines
    .map((line) => formatTranscriptLine(line, s.transcriptFormat))
    .filter((line) => line.toLowerCase().includes(term.toLowerCase()));
  if (matches.length === 0) {
    s.push("status", `Search "${term}" — no matches`);
    return;
  }
  s.push(
    "status",
    `Search "${term}" — ${matches.length} match${matches.length === 1 ? "" : "es"}\n${matches.map((m) => `  ${m}`).join("\n")}`,
  );
}

/** U5 — plain-mode `/trace`: the discovery event log. */
export function showTraceImpl(s: SessionClusterCtx): void {
  if (s.discoveryEvents.length === 0) {
    s.push("status", "Trace (0) — no events yet");
    return;
  }
  s.push(
    "status",
    `Trace (${s.discoveryEvents.length})\n${[...s.discoveryEvents]
      .reverse()
      .map((e) => `  ${e.at} ${e.peerId} ${e.type}`)
      .join("\n")}`,
  );
}

/** U1 — render the host's cluster status (`cluster/status`). */
export async function showClusterStatusImpl(
  s: SessionSink,
): Promise<void> {
  let cluster;
  try {
    cluster = await s.client.clusterStatus();
  } catch (err) {
    s.push("status", `cluster unavailable: ${(err as Error).message}`);
    return;
  }
  if (cluster.peers.length === 0) {
    s.push(
      "status",
      `Cluster (0) — no peers connected (${cluster.connected}/${cluster.failed})`,
    );
    return;
  }
  const lines = cluster.peers.map((p) => {
    const model = p.model !== undefined ? ` model=${p.model}` : "";
    const caps =
      p.capabilities !== undefined && p.capabilities.length > 0
        ? ` capabilities=${p.capabilities.join(",")}`
        : "";
    const health = p.health.ok
      ? ` ok${p.health.rttMs !== undefined ? ` rtt=${p.health.rttMs}ms` : ""}`
      : ` down${p.health.error !== undefined ? ` (${p.health.error})` : ""}`;
    return `- ${p.id}${model}${caps}${health}`;
  });
  s.push(
    "status",
    `Cluster (${cluster.peers.length} connected=${cluster.connected} failed=${cluster.failed})\n${lines.join("\n")}`,
  );
}

/** U1 — render the host's team jobs (`team/jobs`). */
export async function showTeamJobsImpl(s: SessionSink): Promise<void> {
  let jobs;
  try {
    jobs = await s.client.teamJobs();
  } catch (err) {
    s.push("status", `team unavailable: ${(err as Error).message}`);
    return;
  }
  if (jobs.length === 0) {
    s.push("status", "Team (0) — no jobs");
    return;
  }
  const lines = jobs.map((j) => {
    const cost = j.costUsd !== undefined ? ` cost=${j.costUsd}` : "";
    const agents = j.agents
      .map((a) => `${a.id}@${a.host}=${a.status}`)
      .join(", ");
    return `- ${j.jobId} ${j.status}${cost}\n    ${agents}`;
  });
  s.push("status", `Team (${jobs.length})\n${lines.join("\n")}`);
}

/** U1 — render the host's peer reputation scoreboard (`scoreboard/summary`). */
export async function showScoreboardImpl(s: SessionSink): Promise<void> {
  let entries;
  try {
    entries = await s.client.scoreboardSummary();
  } catch (err) {
    s.push("status", `scoreboard unavailable: ${(err as Error).message}`);
    return;
  }
  if (entries.length === 0) {
    s.push("status", "Scoreboard (0) — no verdicts yet");
    return;
  }
  const lines = entries.map(
    (e) =>
      `- ${e.workerPeerId} ${e.skillId} score=${e.score} pass=${e.passCount} fail=${e.failCount} partial=${e.partialCount}`,
  );
  s.push("status", `Scoreboard (${entries.length})\n${lines.join("\n")}`);
}
