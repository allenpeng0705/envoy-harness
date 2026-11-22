import type { JSX } from "react";

export interface EmptyHeroProps {
  ready: boolean;
  sessionId: string | null;
  /**
   * Registered project display name when the session is in one.
   * Omit / null / empty → no-project empty state (never show launch cwd).
   */
  projectName?: string | null;
  /** Opens the project picker; omitted in read-only/embedded hosts. */
  onOpenProject?: () => void;
}

export function EmptyHero(props: EmptyHeroProps): JSX.Element {
  if (!props.ready) {
    return (
      <div className="empty-hero">
        <p className="hero-brand">envoy</p>
        <p className="hero-sub">Connecting to ACP…</p>
      </div>
    );
  }

  const project = props.projectName?.trim() ?? "";
  const inProject = project.length > 0;

  return (
    <div className="empty-hero">
      <p className="hero-brand">envoy</p>
      {inProject ? (
        <>
          <p className="hero-sub">
            Working in <span className="mono">{project}</span>. Ask anything to
            start this session.
          </p>
          <ul className="hero-meta">
            {props.sessionId ? (
              <li className="mono">session · {props.sessionId.slice(0, 8)}…</li>
            ) : null}
          </ul>
          {props.onOpenProject !== undefined ? (
            <button
              type="button"
              className="hero-action secondary"
              onClick={props.onOpenProject}
            >
              Switch project…
            </button>
          ) : null}
        </>
      ) : (
        <>
          <p className="hero-sub">
            No project selected. Open one to work in a directory — or just start
            chatting.
          </p>
          <ul className="hero-meta">
            {props.sessionId ? (
              <li className="mono">session · {props.sessionId.slice(0, 8)}…</li>
            ) : null}
          </ul>
          {props.onOpenProject !== undefined ? (
            <button
              type="button"
              className="hero-action"
              onClick={props.onOpenProject}
            >
              Open a project…
            </button>
          ) : null}
          <p className="hero-hint">
            Without a project, the session uses a private scratch folder — it
            never shows up as a project.
          </p>
        </>
      )}
    </div>
  );
}
