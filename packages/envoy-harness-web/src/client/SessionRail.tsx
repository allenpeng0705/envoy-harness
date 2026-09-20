import type { JSX } from "react";
import type { SessionSummary } from "./acp/host.js";
import { ConnectionIndicator } from "./ConnectionIndicator.js";
import type { ConnectionState } from "./acp/host.js";
import { groupSessionsByProject } from "./session-groups.js";

export interface SessionRailProps {
  connectionState: ConnectionState;
  retryAttempt: number;
  onReconnect: () => void;
  sessions: SessionSummary[];
  activeSessionId: string | null;
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
  const groups = groupSessionsByProject(props.sessions);

  const renderSession = (s: SessionSummary): JSX.Element => (
    <li key={s.id}>
      <button
        type="button"
        className={
          s.id === props.activeSessionId ? "session-row active" : "session-row"
        }
        onClick={() => props.onResume(s.id)}
      >
        <span className="session-title">{s.title ?? "untitled"}</span>
        <span className="session-meta mono">
          {s.id.slice(0, 8)} · {s.messageCount} msgs
        </span>
      </button>
    </li>
  );

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
          <p className="rail-section">Projects</p>
          <ul className="session-list">
            {groups.length === 0 ? (
              <li className="muted">No persisted sessions</li>
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
                  <ul className="project-sessions">{g.sessions.map(renderSession)}</ul>
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
