/**
 * EHUI React shell — tab strip + panel bodies for EnvoyGo / EnvoyMesh.
 */

import { useCallback, useEffect, useState, type JSX } from "react";

import {
  EHUI_PANELS,
  type ClientClusterStatus,
  type ClientDiscoveryEvent,
  type ClientPeerInfo,
  type ClientScoreboardEntry,
  type ClientSessionSummary,
  type ClientTeamJob,
  type EhuiDataSource,
  type EhuiPanelId,
} from "@envoymesh/envoy-harness-client/ehui";

export type { EhuiPanelId };

export interface EhuiShellProps {
  dataSource: EhuiDataSource;
  activePanel?: EhuiPanelId;
  onPanelChange?: (panel: EhuiPanelId) => void;
  /** Bump to reload the active panel (e.g. after a chat turn completes). */
  refreshKey?: number;
  className?: string;
}

const PANEL_IDS: EhuiPanelId[] = EHUI_PANELS
  .map((p) => p.id)
  .filter((id) => id !== "chat");

const PLAN_ACTIONS = ["show", "approve", "reject", "clear"] as const;
const MEMORY_OPS = ["list", "read", "add"] as const;

function formatCluster(c: ClientClusterStatus): string {
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

function formatPeers(peers: ClientPeerInfo[]): string {
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

function formatTeamJobs(jobs: ClientTeamJob[]): string {
  if (jobs.length === 0) return "No team jobs.";
  return jobs
    .map((j) => {
      const agents = j.agents.map((a) => `${a.id}:${a.status}`).join(", ");
      const cost = j.costUsd !== undefined ? ` $${j.costUsd.toFixed(3)}` : "";
      return `${j.jobId} [${j.status}]${cost}\n  ${agents}`;
    })
    .join("\n\n");
}

function formatScoreboard(entries: ClientScoreboardEntry[]): string {
  if (entries.length === 0) return "No scoreboard entries.";
  return entries
    .map(
      (e) =>
        `${e.workerPeerId} · ${e.skillId}: score ${e.score} (pass ${e.passCount} / fail ${e.failCount} / partial ${e.partialCount})`,
    )
    .join("\n");
}

function formatSessions(rows: ClientSessionSummary[]): string {
  if (rows.length === 0) return "No saved sessions.";
  return rows
    .map((s) => {
      const title = s.title ?? s.id;
      const cwd = s.cwd ? ` · ${s.cwd}` : "";
      return `${title}${cwd}\n  ${s.messageCount} msgs · ${s.id}`;
    })
    .join("\n\n");
}

function formatDiscoveryEvent(ev: ClientDiscoveryEvent): string {
  const parts = [ev.at, ev.type, ev.peerId];
  if (ev.model) parts.push(ev.model);
  if (ev.rttMs !== undefined) parts.push(`${ev.rttMs}ms`);
  if (ev.error) parts.push(ev.error);
  return parts.join(" · ");
}

export function EhuiShell(props: EhuiShellProps): JSX.Element {
  const [panel, setPanel] = useState<EhuiPanelId>(
    props.activePanel ?? "plan",
  );
  const [body, setBody] = useState<string>("");
  const [error, setError] = useState<string | undefined>();
  const [clusterLine, setClusterLine] = useState<string>("");
  const [planAction, setPlanAction] = useState<string>("show");
  const [memoryOp, setMemoryOp] = useState<string>("list");
  const [memoryName, setMemoryName] = useState<string>("");
  const [memoryBody, setMemoryBody] = useState<string>("");
  const [gitStaged, setGitStaged] = useState(false);
  const [gitStat, setGitStat] = useState(false);

  const select = useCallback(
    (id: EhuiPanelId) => {
      setPanel(id);
      props.onPanelChange?.(id);
    },
    [props.onPanelChange],
  );

  const reloadPanel = useCallback(async (): Promise<void> => {
    setError(undefined);
    try {
      let text = "";
      if (panel === "plan") {
        text = await props.dataSource.plan(planAction);
      } else if (panel === "memory") {
        text = await props.dataSource.memory(
          memoryOp as "list" | "read" | "add",
          {
            ...(memoryName ? { name: memoryName } : {}),
            ...(memoryBody ? { body: memoryBody } : {}),
          },
        );
      } else if (panel === "git-diff") {
        text = await props.dataSource.gitDiff({
          staged: gitStaged,
          stat: gitStat,
        });
      } else if (panel === "git-status") {
        text = await props.dataSource.gitStatus();
      } else if (panel === "mesh" || panel === "cluster") {
        text = formatCluster(await props.dataSource.clusterStatus());
      } else if (panel === "peers") {
        text = formatPeers(await props.dataSource.listPeers());
      } else if (panel === "team") {
        text = formatTeamJobs(await props.dataSource.teamJobs());
      } else if (panel === "scoreboard") {
        text = formatScoreboard(await props.dataSource.scoreboardSummary());
      } else if (panel === "resume") {
        text = formatSessions(await props.dataSource.listSessions());
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
    props.dataSource,
  ]);

  useEffect(() => {
    if (props.activePanel !== undefined && props.activePanel !== panel) {
      setPanel(props.activePanel);
    }
  }, [props.activePanel, panel]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await reloadPanel();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, props.refreshKey, reloadPanel]);

  useEffect(() => {
    if (panel !== "trace") return;
    let cancelled = false;
    const lines: string[] = [];
    let unsubscribe: (() => void) | undefined;
    void props.dataSource
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
  }, [panel, props.dataSource, props.refreshKey]);

  useEffect(() => {
    void props.dataSource.clusterStatus().then((c) => {
      setClusterLine(`mesh ${c.connected}/${c.peers.length} peers`);
    }).catch(() => {
      setClusterLine("");
    });
  }, [props.dataSource, props.refreshKey]);

  return (
    <div className={props.className} data-ehui-shell>
      <div className="ehui-rail" style={{ fontSize: 12, opacity: 0.8 }}>
        {clusterLine}
      </div>
      <nav
        className="ehui-tabs"
        style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
      >
        {PANEL_IDS.map((id) => {
          const meta = EHUI_PANELS.find((p) => p.id === id);
          const label = meta?.label ?? id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => select(id)}
              aria-pressed={panel === id}
              style={{
                fontWeight: panel === id ? 600 : 400,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 12,
                padding: "2px 4px",
              }}
            >
              {label}
            </button>
          );
        })}
      </nav>
      {panel === "plan" ? (
        <div className="ehui-panel-actions" style={{ display: "flex", gap: 6, marginTop: 6 }}>
          {PLAN_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => setPlanAction(action)}
              aria-pressed={planAction === action}
            >
              {action}
            </button>
          ))}
        </div>
      ) : null}
      {panel === "memory" ? (
        <div className="ehui-panel-actions" style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {MEMORY_OPS.map((op) => (
              <button
                key={op}
                type="button"
                onClick={() => setMemoryOp(op)}
                aria-pressed={memoryOp === op}
              >
                {op}
              </button>
            ))}
            <button type="button" onClick={() => void reloadPanel()}>Run</button>
          </div>
          {memoryOp !== "list" ? (
            <input
              type="text"
              placeholder="memory name"
              value={memoryName}
              onChange={(e) =>
                setMemoryName((e.target as HTMLInputElement).value)
              }
              style={{ fontSize: 12 }}
            />
          ) : null}
          {memoryOp === "add" ? (
            <textarea
              placeholder="memory body"
              value={memoryBody}
              onChange={(e) =>
                setMemoryBody((e.target as HTMLTextAreaElement).value)
              }
              rows={2}
              style={{ fontSize: 12 }}
            />
          ) : null}
        </div>
      ) : null}
      {panel === "git-diff" ? (
        <div className="ehui-panel-actions" style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={gitStaged}
              onChange={(e) =>
                setGitStaged((e.target as HTMLInputElement).checked)
              }
            />
            staged
          </label>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={gitStat}
              onChange={(e) =>
                setGitStat((e.target as HTMLInputElement).checked)
              }
            />
            stat
          </label>
          <button type="button" onClick={() => void reloadPanel()}>Refresh</button>
        </div>
      ) : null}
      {error !== undefined ? (
        <pre className="ehui-error" style={{ color: "crimson" }}>{error}</pre>
      ) : (
        <pre
          className="ehui-body"
          style={{
            whiteSpace: "pre-wrap",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            marginTop: 8,
            flex: 1,
            minHeight: 0,
            overflow: "auto",
          }}
        >
          {body}
        </pre>
      )}
    </div>
  );
}

export { EHUI_PANELS } from "@envoymesh/envoy-harness-client/ehui";
