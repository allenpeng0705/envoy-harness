/**
 * U3 — detail-view renderers for the dedicated TUI. Pure functions:
 * each takes the protocol snapshot and returns lines for the screen's
 * content area. Hermetic-tested without a TTY.
 */

import type {
  ClientClusterStatus,
  ClientDiscoveryEvent,
  ClientPeerInfo,
  ClientScoreboardEntry,
  ClientTeamJob,
} from "@envoymesh/envoy-harness-client";

function peerLabel(p: ClientPeerInfo): string {
  const model = p.model !== undefined ? ` ${p.model}` : "";
  const caps =
    p.capabilities !== undefined && p.capabilities.length > 0
      ? ` caps=${[...p.capabilities].join(",")}`
      : "";
  return `${p.id}${model}${caps}`;
}

/** `/cluster` — per-peer health + totals + routing previews. */
export function renderClusterView(
  cluster: ClientClusterStatus,
  routePreviews?: ReadonlyArray<{
    tag: string;
    peer: ClientPeerInfo | undefined;
  }>,
): string[] {
  const lines = [
    `Cluster · connected ${cluster.connected} / failed ${cluster.failed}`,
  ];
  if (cluster.peers.length === 0) {
    lines.push("  no peers configured");
    return lines;
  }
  for (const p of cluster.peers) {
    lines.push(`  ${peerLabel(p)}`);
    if (p.health.ok) {
      const rtt = p.health.rttMs !== undefined ? ` rtt=${p.health.rttMs}ms` : "";
      const at =
        p.health.lastPingAt !== undefined ? ` since ${p.health.lastPingAt}` : "";
      lines.push(`    health: ok${rtt}${at}`);
    } else {
      const error =
        p.health.error !== undefined ? ` (${p.health.error})` : "";
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
    lines.push("  /route <tag> — preview which peer a task would go to");
  }
  return lines;
}

/** `/route <tag>` — routing preview for one capability tag. */
export function renderRouteView(input: {
  tag: string;
  peer: ClientPeerInfo | undefined;
}): string[] {
  if (input.peer === undefined) {
    return [`Route "${input.tag}" → no peer available`];
  }
  return [`Route "${input.tag}" → ${peerLabel(input.peer)}`];
}

/** `/peers` — flat peer list (same data as the rail, full detail). */
export function renderPeersView(peers: readonly ClientPeerInfo[]): string[] {
  if (peers.length === 0) return ["Peers (0) — no peers configured"];
  return [`Peers (${peers.length})`, ...peers.map((p) => `  ${peerLabel(p)}`)];
}

/** `/team` — live team jobs: agents, hosts, status, cost. */
export function renderTeamView(jobs: readonly ClientTeamJob[]): string[] {
  if (jobs.length === 0) return ["Team (0) — no jobs"];
  const lines: string[] = [`Team (${jobs.length})`];
  for (const job of jobs) {
    const cost = job.costUsd !== undefined ? ` cost=${job.costUsd}` : "";
    lines.push(`  ${job.jobId} ${job.status}${cost} @ ${job.createdAt}`);
    for (const agent of job.agents) {
      const model = agent.model !== undefined ? ` ${agent.model}` : "";
      const costA = agent.costUsd !== undefined ? ` cost=${agent.costUsd}` : "";
      lines.push(`    ${agent.id} @ ${agent.host}${model} = ${agent.status}${costA}`);
    }
  }
  return lines;
}

/** `/scoreboard` — reputation per (peer, skill). */
export function renderScoreboardView(
  entries: readonly ClientScoreboardEntry[],
): string[] {
  if (entries.length === 0) return ["Scoreboard (0) — no verdicts yet"];
  return [
    `Scoreboard (${entries.length})`,
    ...entries.map(
      (e) =>
        `  ${e.workerPeerId} ${e.skillId} score=${e.score} pass=${e.passCount} fail=${e.failCount} partial=${e.partialCount}`,
    ),
  ];
}

/** The discovery ticker (last events, newest first), shown above the input. */
export function renderDiscoveryTicker(
  events: readonly ClientDiscoveryEvent[],
  max = 3,
): string[] {
  return events
    .slice(-max)
    .reverse()
    .map((e) => {
      const detail =
        e.type === "peer.connected"
          ? "connected"
          : e.type === "peer.disconnected"
            ? "disconnected"
            : e.type === "peer.failed"
              ? `failed${e.error !== undefined ? `: ${e.error}` : ""}`
              : e.rttMs !== undefined
                ? `rtt=${e.rttMs}ms`
                : "health";
      return `! ${e.peerId} ${detail}`;
    });
}

/** `/search <term>` — transcript lines containing the term (case-insensitive). */
export function renderSearchView(
  transcript: readonly string[],
  term: string,
): string[] {
  const needle = term.toLowerCase();
  const matches = transcript.filter((line) =>
    line.toLowerCase().includes(needle),
  );
  if (matches.length === 0) {
    return [`Search "${term}" — no matches`];
  }
  return [
    `Search "${term}" — ${matches.length} match${matches.length === 1 ? "" : "es"}`,
    ...matches.map((line) => `  ${line}`),
  ];
}

/** `/trace` — the discovery/peer event log (newest first). */
export function renderTraceView(
  events: readonly ClientDiscoveryEvent[],
): string[] {
  if (events.length === 0) return ["Trace (0) — no events yet"];
  return [
    `Trace (${events.length})`,
    ...[...events].reverse().map((e) => {
      const detail =
        e.type === "peer.connected"
          ? "connected"
          : e.type === "peer.disconnected"
            ? "disconnected"
            : e.type === "peer.failed"
              ? `failed${e.error !== undefined ? `: ${e.error}` : ""}`
              : e.rttMs !== undefined
                ? `rtt=${e.rttMs}ms`
                : "health";
      return `  ${e.at} ${e.peerId} ${detail}`;
    }),
  ];
}
