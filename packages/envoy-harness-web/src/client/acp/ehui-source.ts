/**
 * Browser EhuiDataSource backed by AcpHost JSON-RPC.
 */

import type {
  ClientClusterStatus,
  ClientDiscoveryEvent,
  ClientPeerInfo,
  ClientScoreboardEntry,
  ClientSessionSummary,
  ClientTeamJob,
  EhuiDataSource,
} from "@envoymesh/envoy-harness-client/ehui";

import type { AcpHost } from "./host.js";

export function createBrowserEhuiDataSource(
  host: AcpHost,
  sessionId: string,
): EhuiDataSource {
  return {
    sessionId,
    async plan(action, options) {
      const res = (await host.request("session/plan", {
        sessionId,
        action,
        ...(options?.text !== undefined ? { text: options.text } : {}),
        ...(options?.reason !== undefined ? { reason: options.reason } : {}),
      })) as { output?: string };
      return res.output ?? "";
    },
    async memory(op, options) {
      const res = (await host.request("session/memory", {
        sessionId,
        op,
        ...(options?.name !== undefined ? { name: options.name } : {}),
        ...(options?.body !== undefined ? { body: options.body } : {}),
      })) as { output?: string };
      return res.output ?? "";
    },
    async gitDiff(options) {
      const res = (await host.request("git/diff", {
        sessionId,
        ...(options?.staged !== undefined ? { staged: options.staged } : {}),
        ...(options?.stat !== undefined ? { stat: options.stat } : {}),
      })) as { output?: string };
      return res.output ?? "";
    },
    async gitStatus() {
      const res = (await host.request("git/status", { sessionId })) as {
        output?: string;
      };
      return res.output ?? "";
    },
    async clusterStatus() {
      const res = (await host.request("cluster/status", {})) as {
        cluster: ClientClusterStatus;
      };
      return res.cluster;
    },
    async listPeers() {
      const res = (await host.request("peers/list", {})) as {
        peers: ClientPeerInfo[];
      };
      return res.peers ?? [];
    },
    async teamJobs() {
      const res = (await host.request("team/jobs", {})) as {
        jobs: ClientTeamJob[];
      };
      return res.jobs ?? [];
    },
    async scoreboardSummary() {
      const res = (await host.request("scoreboard/summary", {})) as {
        entries: ClientScoreboardEntry[];
      };
      return res.entries ?? [];
    },
    async listSessions() {
      const res = (await host.request("sessions/list", {})) as {
        sessions: ClientSessionSummary[];
      };
      return res.sessions ?? [];
    },
    async subscribeDiscovery(listener) {
      return host.onNotification("discovery/event", (params) => {
        listener(params as ClientDiscoveryEvent);
      });
    },
  };
}
