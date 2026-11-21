import { useMemo, useState, type JSX } from "react";
import type { SessionSummary } from "./acp/host.js";
import { ConnectionIndicator } from "./ConnectionIndicator.js";
import type { ConnectionState } from "./acp/host.js";
import {
  filterSessions,
  formatSessionWhen,
  groupSessionsByProject,
  visibleSessions,
  type RegisteredProject,
} from "./session-groups.js";
import { shortPathLabel } from "./path-display.js";

export interface SessionRailProps {
  connectionState: ConnectionState;
  retryAttempt: number;
  onReconnect: () => void;
  sessions: SessionSummary[];
  /** Manual workspace registry — the only source of "Projects" sections. */
  workspaces: readonly RegisteredProject[];
  activeSessionId: string | null;
  pinnedIds: ReadonlySet<string>;
  archivedIds: ReadonlySet<string>;
  onTogglePin: (id: string) => void;
  onToggleArchive: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onNewSession: () => void;
  onNewSessionIn: (cwd: string) => void;
  onOpenProjects: () => void;
  onResume: (id: string) => void;
  onOpenSettings: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  provider: string;
  model: string;
}

export function SessionRail(props: SessionRailProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const archivedCount = useMemo(() => {
    let n = 0;
    for (const s of props.sessions) {
      if (props.archivedIds.has(s.id)) n += 1;
    }
    return n;
  }, [props.sessions, props.archivedIds]);

  const groups = useMemo(() => {
    const visible = visibleSessions(
      props.sessions,
      props.archivedIds,
      showArchived,
    );
    const filtered = filterSessions(visible, query);
    // Show Ungrouped so auto-resumed / scratch sessions remain reachable
    // without promoting their cwd to a fake project heading.
    return groupSessionsByProject(filtered, props.pinnedIds, props.workspaces, {
      includeUngrouped: true,
    });
  }, [
    props.sessions,
    props.workspaces,
    props.archivedIds,
    props.pinnedIds,
    query,
    showArchived,
  ]);

  const renderSession = (s: SessionSummary): JSX.Element => {
    const pinned = props.pinnedIds.has(s.id);
    const archived = props.archivedIds.has(s.id);
    const when = formatSessionWhen(s.mtimeMs);
    const metaParts = [
      `${s.messageCount} msg${s.messageCount === 1 ? "" : "s"}`,
      ...(when ? [when] : []),
      s.id.slice(0, 8),
    ];
    return (
      <li
        key={s.id}
        className={`session-item${archived ? " archived" : ""}`}
      >
        <button
          type="button"
          className={
            s.id === props.activeSessionId
              ? "session-row active"
              : "session-row"
          }
          onClick={() => props.onResume(s.id)}
        >
          <span className="session-title">
            {pinned ? "★ " : ""}
            {archived ? "▾ " : ""}
            {s.title ?? "untitled"}
          </span>
          <span className="session-meta mono">{metaParts.join(" · ")}</span>
          {s.cwd !== undefined && s.cwd.trim().length > 0 ? (
            <span className="session-cwd mono" title={s.cwd}>
              {shortPathLabel(s.cwd, 36)}
            </span>
          ) : null}
        </button>
        <div className="session-actions">
          <button
            type="button"
            className="icon-btn tiny"
            title={pinned ? "Unpin" : "Pin"}
            aria-label={
              pinned ? `Unpin ${s.title ?? s.id}` : `Pin ${s.title ?? s.id}`
            }
            onClick={() => props.onTogglePin(s.id)}
          >
            {pinned ? "★" : "☆"}
          </button>
          <button
            type="button"
            className="icon-btn tiny"
            title={archived ? "Unarchive" : "Archive"}
            aria-label={
              archived
                ? `Unarchive ${s.title ?? s.id}`
                : `Archive ${s.title ?? s.id}`
            }
            onClick={() => props.onToggleArchive(s.id)}
          >
            {archived ? "↥" : "↧"}
          </button>
          <button
            type="button"
            className="icon-btn tiny"
            title="Rename"
            aria-label={`Rename ${s.title ?? s.id}`}
            onClick={() => {
              const next = window.prompt("Session title", s.title ?? "");
              if (next !== null && next.trim() !== "") {
                props.onRename(s.id, next.trim());
              }
            }}
          >
            ✎
          </button>
          <button
            type="button"
            className="icon-btn tiny"
            title="Delete"
            aria-label={`Delete ${s.title ?? s.id}`}
            onClick={() => {
              if (
                window.confirm(
                  `Delete session ${s.title ?? s.id.slice(0, 8)}? This cannot be undone.`,
                )
              ) {
                props.onDelete(s.id);
              }
            }}
          >
            ×
          </button>
        </div>
      </li>
    );
  };

  return (
    <aside
      className={`session-rail${props.collapsed ? " collapsed" : ""}`}
      aria-label="Sessions"
    >
      <div className="rail-head">
        {!props.collapsed ? (
          <>
            <p className="brand">envoy</p>
            <ConnectionIndicator
              state={props.connectionState}
              retryAttempt={props.retryAttempt}
              onReconnect={props.onReconnect}
            />
          </>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          title={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={props.onToggleCollapsed}
        >
          {props.collapsed ? "»" : "«"}
        </button>
      </div>

      {!props.collapsed ? (
        <>
          <button
            type="button"
            className="primary new-session"
            onClick={props.onNewSession}
          >
            New session
          </button>
          <button
            type="button"
            className="new-session-secondary"
            onClick={props.onOpenProjects}
          >
            Open project…
          </button>

          <div className="session-browser-tools">
            <label className="session-search">
              <span className="sr-only">Filter sessions</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter title, id, path…"
                aria-label="Filter sessions"
              />
            </label>
            {archivedCount > 0 ? (
              <button
                type="button"
                className={`session-archive-toggle${showArchived ? " active" : ""}`}
                aria-pressed={showArchived}
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived
                  ? `Hide archived (${archivedCount})`
                  : `Show archived (${archivedCount})`}
              </button>
            ) : null}
          </div>

          <p className="rail-section">Projects</p>
          <ul className="session-list">
            {groups.length === 0 ? (
              <li className="muted">
                {query.trim().length > 0
                  ? "No matching sessions"
                  : props.workspaces.length === 0
                    ? "No projects yet — add one with Open project…"
                    : showArchived
                      ? "No sessions"
                      : "No persisted sessions"}
              </li>
            ) : (
              groups.map((g) => (
                <li
                  key={g.cwd === "" ? "__other__" : g.cwd}
                  className="project-group"
                >
                  <div className="project-head">
                    <span className="project-name" title={g.cwd || undefined}>
                      {g.label}
                    </span>
                    {g.cwd !== "" ? (
                      <button
                        type="button"
                        className="icon-btn tiny"
                        title={`New session in ${g.cwd}`}
                        aria-label={`New session in ${g.label}`}
                        onClick={() => props.onNewSessionIn(g.cwd)}
                      >
                        +
                      </button>
                    ) : null}
                  </div>
                  {g.cwd !== "" ? (
                    <p className="project-path mono" title={g.cwd}>
                      {g.cwd}
                    </p>
                  ) : null}
                  <ul className="project-sessions">
                    {g.sessions.map(renderSession)}
                  </ul>
                </li>
              ))
            )}
          </ul>
          <div className="rail-foot">
            <p className="muted compact">
              {props.provider || "provider?"}
              {props.model ? ` / ${props.model}` : ""}
            </p>
            <button type="button" onClick={props.onOpenSettings}>
              Settings
            </button>
          </div>
        </>
      ) : (
        <div className="rail-collapsed-actions">
          <button
            type="button"
            className="icon-btn"
            title="New session"
            onClick={props.onNewSession}
          >
            +
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Open project"
            onClick={props.onOpenProjects}
          >
            ▤
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Settings"
            onClick={props.onOpenSettings}
          >
            ⚙
          </button>
        </div>
      )}
    </aside>
  );
}
