/**
 * R7.2 — EHUI list/mesh formatters (TUI-aligned plain text for non-structured panels).
 */

import type {
  ClientClusterStatus,
  ClientDiscoveryEvent,
  ClientPeerInfo,
  ClientScoreboardEntry,
  ClientSessionSummary,
  ClientTeamJob,
} from "@envoymesh/envoy-harness-client/ehui";

function peerLabel(p: ClientPeerInfo): string {
  const model = p.model !== undefined ? ` ${p.model}` : "";
  const caps =
    p.capabilities !== undefined && p.capabilities.length > 0
      ? ` caps=${[...p.capabilities].join(",")}`
      : "";
  return `${p.id}${model}${caps}`;
}

/** Exported for hosts / tests that format a peer the same way as EHUI lists. */
export { peerLabel };

/** Mesh onboarding guide (distinct from cluster health). */
export function formatMesh(options?: {
  configuredPeers?: ReadonlyArray<{ id: string; endpoint: string }>;
  connected?: number;
  failed?: number;
}): string {
  const lines = [
    "Mesh — collaborate across envoy-harness nodes",
    "",
    "Quick start:",
    "  1. On each worker: envoy-peer serve --port 18123",
    "  2. Wire peers: --peers w1@127.0.0.1:18123",
    "  3. Explore: /cluster /peers /scoreboard /team /trace",
    "",
    "Slash / panels:",
    "  Mesh / Cluster / Peers / Team / Scoreboard / Trace",
  ];
  if (options?.configuredPeers !== undefined && options.configuredPeers.length > 0) {
    lines.push("", "Configured endpoints:");
    for (const peer of options.configuredPeers) {
      // Only real host:port (or similar) values — never model ids.
      if (peer.endpoint.trim().length === 0) continue;
      lines.push(`  ${peer.id} → ${peer.endpoint}`);
    }
  }
  if (options?.connected !== undefined) {
    lines.push(
      "",
      `Live status: connected ${options.connected}, failed ${options.failed ?? 0}`,
    );
  }
  return lines.join("\n");
}

export function formatCluster(
  c: ClientClusterStatus,
  routePreviews?: ReadonlyArray<{
    tag: string;
    peer: ClientPeerInfo | undefined;
  }>,
): string {
  const lines = [
    `Cluster · connected ${c.connected} / failed ${c.failed}`,
  ];
  if (c.peers.length === 0) {
    lines.push("  no peers configured");
    return lines.join("\n");
  }
  for (const p of c.peers) {
    lines.push(`  ${peerLabel(p)}`);
    if (p.health.ok) {
      const rtt = p.health.rttMs !== undefined ? ` rtt=${p.health.rttMs}ms` : "";
      lines.push(`    health: ok${rtt}`);
    } else {
      const error = p.health.error !== undefined ? ` (${p.health.error})` : "";
      lines.push(`    health: down${error}`);
    }
  }
  if (routePreviews !== undefined && routePreviews.length > 0) {
    lines.push("  routing:");
    for (const preview of routePreviews) {
      lines.push(
        preview.peer === undefined
          ? `    ${preview.tag} → no peer`
          : `    ${preview.tag} → ${peerLabel(preview.peer)}`,
      );
    }
  } else {
    lines.push("  routing: open Route preview from slash /route <tag>");
  }
  return lines.join("\n");
}

export function formatPeers(peers: ClientPeerInfo[]): string {
  if (peers.length === 0) return "Peers (0) — no peers configured";
  return [`Peers (${peers.length})`, ...peers.map((p) => `  ${peerLabel(p)}`)].join(
    "\n",
  );
}

export function formatTeamJobs(jobs: ClientTeamJob[]): string {
  if (jobs.length === 0) return "Team (0) — no jobs";
  const lines: string[] = [`Team (${jobs.length})`];
  for (const job of jobs) {
    const cost = job.costUsd !== undefined ? ` cost=${job.costUsd}` : "";
    lines.push(`  ${job.jobId} ${job.status}${cost} @ ${job.createdAt}`);
    for (const agent of job.agents) {
      const model = agent.model !== undefined ? ` ${agent.model}` : "";
      const costA = agent.costUsd !== undefined ? ` cost=${agent.costUsd}` : "";
      lines.push(
        `    ${agent.id} @ ${agent.host}${model} = ${agent.status}${costA}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatScoreboard(entries: ClientScoreboardEntry[]): string {
  if (entries.length === 0) return "Scoreboard (0) — no entries";
  const lines = ["Scoreboard"];
  for (const e of entries) {
    lines.push(
      `  ${e.workerPeerId} · ${e.skillId}: score ${e.score} (pass ${e.passCount} / fail ${e.failCount} / partial ${e.partialCount})`,
    );
  }
  return lines.join("\n");
}

export function formatSessions(rows: ClientSessionSummary[]): string {
  if (rows.length === 0) {
    return "Resume session\n  no persisted sessions — use --persist";
  }
  const lines = [
    "Resume session",
    "  #   id          messages  title / cwd",
  ];
  rows.forEach((s, i) => {
    const title = s.title ?? s.cwd ?? "—";
    const shortId = shortSessionId(s.id);
    lines.push(
      `  ${String(i + 1).padStart(2)}  ${shortId.padEnd(12)} ${String(s.messageCount).padStart(3)}     ${title}`,
    );
  });
  return lines.join("\n");
}

/** Display helpers for clickable Resume rows (R7.5). */
export function shortSessionId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

export function resumeSessionTitle(s: ClientSessionSummary): string {
  return s.title ?? s.cwd ?? s.id;
}

export function formatDiscoveryEvent(ev: ClientDiscoveryEvent): string {
  const parts = [ev.at, ev.type, ev.peerId];
  if (ev.model) parts.push(ev.model);
  if (ev.rttMs !== undefined) parts.push(`${ev.rttMs}ms`);
  if (ev.error) parts.push(ev.error);
  return parts.join(" · ");
}
