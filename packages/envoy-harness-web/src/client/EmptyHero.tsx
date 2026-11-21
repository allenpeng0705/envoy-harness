import type { JSX } from "react";

export interface EmptyHeroProps {
  ready: boolean;
  sessionId: string | null;
  /** @deprecated Launch cwd is not shown — projects are manual-only. */
  cwd?: string;
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
  return (
    <div className="empty-hero">
      <p className="hero-brand">envoy</p>
      <p className="hero-sub">
        Add a project to work in a directory. Launch folder is not a project.
      </p>
      <ul className="hero-meta">
        {props.sessionId ? (
          <li className="mono">session · {props.sessionId.slice(0, 8)}…</li>
        ) : null}
      </ul>
      {props.onOpenProject !== undefined ? (
        <button type="button" className="hero-action" onClick={props.onOpenProject}>
          Open a project…
        </button>
      ) : null}
      <p className="hero-hint">Ask anything to start this session.</p>
    </div>
  );
}
