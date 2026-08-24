import type {
  ClientClusterStatus,
  ClientDiscoveryEvent,
  ClientPeerInfo,
  ClientScoreboardEntry,
  ClientSessionSummary,
  ClientTeamJob,
} from "@envoymesh/envoy-harness-client/ehui";

export function formatCluster(c: ClientClusterStatus): string {
  const lines = [
    `connected ${c.connected} / failed ${c.failed} / peers ${c.peers.length}`,
  ];
  for (const p of c.peers) {
    const health = p.health.ok
      ? `ok${p.health.rttMs !== undefined ? ` ${p.health.rttMs}ms` : ""}`
      : `down${p.health.error ? ` (${p.health.error})` : ""}`;
    const caps =
      p.capabilities && p.capabilities.length > 0
        ? ` [${p.capabilities.join(", ")}]`
        : "";
    lines.push(`${p.id} ${p.model ?? "—"} ${health}${caps}`);
  }
  return lines.join("\n");
}

export function formatPeers(peers: ClientPeerInfo[]): string {
  if (peers.length === 0) return "No peers configured.";
  return peers
    .map((p) => {
      const caps =
        p.capabilities && p.capabilities.length > 0
          ? ` — ${p.capabilities.join(", ")}`
          : "";
      return `${p.id}${p.model ? ` (${p.model})` : ""}${caps}`;
    })
    .join("\n");
}

export function formatTeamJobs(jobs: ClientTeamJob[]): string {
  if (jobs.length === 0) return "No team jobs.";
  return jobs
    .map((j) => {
      const agents = j.agents.map((a) => `${a.id}:${a.status}`).join(", ");
      const cost = j.costUsd !== undefined ? ` $${j.costUsd.toFixed(3)}` : "";
      return `${j.jobId} [${j.status}]${cost}\n  ${agents}`;
    })
    .join("\n\n");
}

export function formatScoreboard(entries: ClientScoreboardEntry[]): string {
  if (entries.length === 0) return "No scoreboard entries.";
  return entries
    .map(
      (e) =>
        `${e.workerPeerId} · ${e.skillId}: score ${e.score} (pass ${e.passCount} / fail ${e.failCount} / partial ${e.partialCount})`,
    )
    .join("\n");
}

export function formatSessions(rows: ClientSessionSummary[]): string {
  if (rows.length === 0) return "No saved sessions.";
  return rows
    .map((s) => {
      const title = s.title ?? s.id;
      return `${title}\n  ${s.messageCount} msgs · ${s.id}`;
    })
    .join("\n\n");
}

export function formatDiscoveryEvent(ev: ClientDiscoveryEvent): string {
  const parts = [ev.at, ev.type, ev.peerId];
  if (ev.model) parts.push(ev.model);
  if (ev.rttMs !== undefined) parts.push(`${ev.rttMs}ms`);
  if (ev.error) parts.push(ev.error);
  return parts.join(" · ");
}
