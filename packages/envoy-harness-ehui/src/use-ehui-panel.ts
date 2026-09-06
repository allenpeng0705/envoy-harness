import { useCallback, useEffect, useState } from "react";

import type { EhuiDataSource, EhuiPanelId } from "@envoymesh/envoy-harness-client/ehui";

import {
  formatCluster,
  formatDiscoveryEvent,
  formatMesh,
  formatPeers,
  formatScoreboard,
  formatSessions,
  formatTeamJobs,
} from "./ehui-format.js";

export interface UseEhuiPanelOptions {
  dataSource: EhuiDataSource;
  panel: EhuiPanelId;
  refreshKey?: number;
}

export function useEhuiPanel(options: UseEhuiPanelOptions) {
  const { dataSource, panel, refreshKey } = options;

  const [body, setBody] = useState<string>("");
  const [error, setError] = useState<string | undefined>();
  const [planAction, setPlanAction] = useState<string>("show");
  const [memoryOp, setMemoryOp] = useState<string>("list");
  const [memoryName, setMemoryName] = useState<string>("");
  const [memoryBody, setMemoryBody] = useState<string>("");
  const [gitStaged, setGitStaged] = useState(false);
  const [gitStat, setGitStat] = useState(false);

  const reloadPanel = useCallback(async (): Promise<void> => {
    setError(undefined);
    try {
      let text = "";
      if (panel === "plan") {
        text = await dataSource.plan(planAction);
      } else if (panel === "memory") {
        text = await dataSource.memory(
          memoryOp as "list" | "read" | "add",
          {
            ...(memoryName ? { name: memoryName } : {}),
            ...(memoryBody ? { body: memoryBody } : {}),
          },
        );
      } else if (panel === "git-diff") {
        text = await dataSource.gitDiff({
          staged: gitStaged,
          stat: gitStat,
        });
      } else if (panel === "git-status") {
        text = await dataSource.gitStatus();
      } else if (panel === "mesh") {
        const c = await dataSource.clusterStatus();
        text = formatMesh({
          connected: c.connected,
          failed: c.failed,
          configuredPeers: c.peers.map((p) => ({
            id: p.id,
            endpoint: p.model ?? "peer",
          })),
        });
      } else if (panel === "cluster") {
        text = formatCluster(await dataSource.clusterStatus());
      } else if (panel === "peers") {
        text = formatPeers(await dataSource.listPeers());
      } else if (panel === "team") {
        text = formatTeamJobs(await dataSource.teamJobs());
      } else if (panel === "scoreboard") {
        text = formatScoreboard(await dataSource.scoreboardSummary());
      } else if (panel === "resume") {
        text = formatSessions(await dataSource.listSessions());
      } else if (panel === "trace") {
        text = "Listening for peer pool health…";
      } else {
        text = "Chat surface is host-owned.";
      }
      setBody(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [
    panel,
    planAction,
    memoryOp,
    memoryName,
    memoryBody,
    gitStaged,
    gitStat,
    dataSource,
  ]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await reloadPanel();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, refreshKey, reloadPanel]);

  useEffect(() => {
    if (panel !== "trace") return;
    let cancelled = false;
    const lines: string[] = [];
    let unsubscribe: (() => void) | undefined;
    void dataSource
      .subscribeDiscovery((ev) => {
        if (cancelled) return;
        lines.push(formatDiscoveryEvent(ev));
        if (lines.length > 200) lines.shift();
        setBody(lines.join("\n"));
      })
      .then((off) => {
        if (cancelled) {
          off();
          return;
        }
        unsubscribe = off;
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [panel, dataSource, refreshKey]);

  return {
    body,
    error,
    reloadPanel,
    planAction,
    setPlanAction,
    memoryOp,
    setMemoryOp,
    memoryName,
    setMemoryName,
    memoryBody,
    setMemoryBody,
    gitStaged,
    setGitStaged,
    gitStat,
    setGitStat,
  };
}
