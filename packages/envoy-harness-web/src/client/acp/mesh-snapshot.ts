/**
 * Mesh / cluster snapshot for the WebUI Mesh rail.
 */

import type {
  MeshAgent,
  MeshAgentStatus,
  MeshSnapshot,
} from "./host-types.js";
import type { WsJsonRpcClient } from "./ws-jsonrpc.js";

const AGENT_STATUSES: readonly MeshAgentStatus[] = [
  "running",
  "completed",
  "failed",
  "partial",
  "unknown",
];

function normalizeStatus(raw: unknown): MeshAgentStatus {
  return typeof raw === "string" &&
    (AGENT_STATUSES as readonly string[]).includes(raw)
    ? (raw as MeshAgentStatus)
    : "unknown";
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

function optionalNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Defensive parse of the structured `agents` array from `session/agents`.
 *
 * Returns `undefined` when the host did not send an array at all (older
 * backend that only supports the preformatted `output`), which is
 * different from `[]` ("no children"). Callers use the distinction to
 * decide whether steering can be offered.
 */
export function parseMeshAgents(raw: unknown): MeshAgent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const agents: MeshAgent[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const id = optionalString(r["id"]);
    if (id === undefined || id === "") continue;
    const startedAt = optionalString(r["startedAt"]);
    const completedAt = optionalString(r["completedAt"]);
    const costUsd = optionalNumber(r["costUsd"]);
    const durationMs = optionalNumber(r["durationMs"]);
    const outputPreview = optionalString(r["outputPreview"]);
    agents.push({
      id,
      capabilityTag: optionalString(r["capabilityTag"]) ?? "",
      objective: optionalString(r["objective"]) ?? "",
      status: normalizeStatus(r["status"]),
      startedAt: startedAt ?? "",
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      steerable: r["steerable"] === true,
      ...(outputPreview !== undefined && outputPreview !== ""
        ? { outputPreview }
        : {}),
    });
  }
  return agents;
}

/**
 * Poll cluster + team + session agents into a MeshSnapshot.
 *
 * When `cluster/status` is unavailable, falls back to `peers/list` and
 * marks every peer `ok: true`. That fallback is **advisory only** — it
 * means "listed", not "health-checked". Prefer cluster/status when the
 * host wires it.
 */
export async function fetchMeshSnapshot(
  client: WsJsonRpcClient,
  sessionId: string,
  previous: MeshSnapshot | null,
  peerCountHint: number,
): Promise<{ mesh: MeshSnapshot; peerCount: number }> {
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
    // Advisory fallback: peers/list has no health — treat as connected=listed.
    try {
      const res = (await client.request("peers/list", {})) as {
        peers?: Array<{ id: string; model?: string }>;
      };
      peers = (res.peers ?? []).map((p) => ({
        id: p.id,
        // Not authoritative health — host lacked cluster/status.
        ok: true,
        ...(p.model !== undefined ? { model: p.model } : {}),
      }));
      peerTotal = peers.length;
      connected = peerTotal;
    } catch {
      // keep previous below
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
  let agents: MeshAgent[] | undefined;
  try {
    const res = (await client.request("session/agents", {
      sessionId,
    })) as { output?: string; agents?: unknown };
    agentsSummary = (res.output ?? "").trim();
    agents = parseMeshAgents(res.agents);
  } catch {
    agentsSummary = "";
    agents = undefined;
  }

  // If both cluster and peers/list failed, preserve prior peer rows.
  if (peerTotal === 0 && previous !== null && previous.peerTotal > 0) {
    return {
      mesh: {
        ...previous,
        teamJobsRunning,
        teamJobsTotal,
        agentsSummary,
        ...(agents !== undefined ? { agents } : {}),
      },
      peerCount: previous.connected,
    };
  }

  const mesh: MeshSnapshot = {
    connected,
    peerTotal,
    failed,
    peers,
    teamJobsRunning,
    teamJobsTotal,
    agentsSummary,
    ...(agents !== undefined ? { agents } : {}),
    ...(previous?.lastDiscovery !== undefined
      ? { lastDiscovery: previous.lastDiscovery }
      : {}),
  };
  return { mesh, peerCount: connected || peerCountHint };
}
