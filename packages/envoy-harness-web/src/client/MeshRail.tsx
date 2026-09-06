import type { JSX } from "react";
import type { MeshSnapshot } from "./acp/host.js";

export interface MeshRailProps {
  mesh: MeshSnapshot | null;
  onRefresh: () => void;
}

export function MeshRail(props: MeshRailProps): JSX.Element {
  const { mesh, onRefresh } = props;
  if (!mesh) {
    return (
      <section className="mesh-rail" aria-label="Distributed agents">
        <header>
          <h2>Mesh</h2>
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
        </header>
        <p className="muted">
          No cluster data yet. Pass{" "}
          <code>--peers id@host:port</code> when starting the WebUI to wire
          remote agents.
        </p>
      </section>
    );
  }

  return (
    <section className="mesh-rail" aria-label="Distributed agents">
      <header>
        <h2>Mesh</h2>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </header>
      <div className="mesh-stats">
        <div>
          <span className="mesh-stat-n">{mesh.connected}</span>
          <span className="mesh-stat-l">connected</span>
        </div>
        <div>
          <span className="mesh-stat-n">{mesh.peerTotal}</span>
          <span className="mesh-stat-l">peers</span>
        </div>
        <div>
          <span className="mesh-stat-n">{mesh.teamJobsRunning}</span>
          <span className="mesh-stat-l">jobs</span>
        </div>
        <div>
          <span className="mesh-stat-n">{mesh.failed}</span>
          <span className="mesh-stat-l">failed</span>
        </div>
      </div>
      {mesh.peers.length > 0 ? (
        <ul className="mesh-peers">
          {mesh.peers.map((p) => (
            <li key={p.id} className={p.ok ? "ok" : "bad"}>
              <span className="mono">{p.id}</span>
              {p.model ? <span className="muted"> · {p.model}</span> : null}
              {!p.ok && p.error ? (
                <span className="err"> · {p.error}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted compact">
          Local-only. Parallel <code>task</code> sub-agents still run via
          LocalMeshSubmitter.
        </p>
      )}
      {mesh.agentsSummary ? (
        <pre className="mesh-agents" title="session/agents">
          {mesh.agentsSummary}
        </pre>
      ) : null}
      {mesh.lastDiscovery ? (
        <p className="muted compact">Last event: {mesh.lastDiscovery}</p>
      ) : null}
    </section>
  );
}
