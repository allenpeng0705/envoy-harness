import type { JSX } from "react";

export interface EmptyHeroProps {
  ready: boolean;
  sessionId: string | null;
  cwd: string;
}

export function EmptyHero(props: EmptyHeroProps): JSX.Element {
  if (!props.ready) {
    return (
      <div className="empty-hero">
        <p className="hero-brand">envoy-harness</p>
        <p className="hero-sub">Connecting to ACP…</p>
      </div>
    );
  }
  return (
    <div className="empty-hero">
      <p className="hero-brand">envoy-harness</p>
      <p className="hero-sub">
        Local task sub-agents run in parallel by default. Wire{" "}
        <code>--peers id@host:port</code> for multi-node mesh.
      </p>
      <ul className="hero-meta">
        {props.cwd ? <li title={props.cwd}>cwd · {props.cwd}</li> : null}
        {props.sessionId ? (
          <li className="mono">session · {props.sessionId.slice(0, 8)}…</li>
        ) : null}
      </ul>
      <p className="hero-hint">Ask anything to start this session.</p>
    </div>
  );
}
