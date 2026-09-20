import { useState, type JSX } from "react";
import type {
  AgentInterruptResult,
  AgentMessageResult,
  MeshAgent,
  MeshAgentStatus,
  MeshSnapshot,
} from "./acp/host.js";

export interface MeshRailProps {
  mesh: MeshSnapshot | null;
  onRefresh: () => void;
  /** Steer a background child; omit to hide the controls. */
  onSendAgentMessage?: (
    agentId: string,
    message: string,
  ) => Promise<AgentMessageResult>;
  /** Interrupt a background child's turn; omit to hide the controls. */
  onInterruptAgent?: (agentId: string) => Promise<AgentInterruptResult>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface AgentNotice {
  text: string;
  error: boolean;
}

function agentGlyph(status: MeshAgentStatus): string {
  switch (status) {
    case "running":
      return "▶";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "partial":
      return "◐";
    default:
      return "?";
  }
}

/** Why steering is unavailable for a child the host reported. */
function steerReason(agent: MeshAgent): string {
  if (agent.steerable) return "";
  return agent.status === "completed" ||
    agent.status === "failed" ||
    agent.status === "partial"
    ? "settled"
    : "not steerable";
}

function agentMeta(agent: MeshAgent): string {
  const bits: string[] = [];
  if (agent.costUsd !== undefined) bits.push(`$${agent.costUsd.toFixed(4)}`);
  if (agent.durationMs !== undefined) {
    bits.push(`${(agent.durationMs / 1000).toFixed(1)}s`);
  }
  return bits.join(" · ");
}

/**
 * The last non-empty line of a child's live output, capped for one row.
 * A preview is a tail of a growing stream, so the newest line is the
 * useful one.
 */
function lastLine(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const last = lines.at(-1) ?? "";
  return last.length > 120 ? `…${last.slice(-120)}` : last;
}

export function MeshRail(props: MeshRailProps): JSX.Element {
  const { mesh, onRefresh, onSendAgentMessage, onInterruptAgent } = props;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, AgentNotice>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const steering =
    onSendAgentMessage !== undefined && onInterruptAgent !== undefined;
  // Structured `agents` is authoritative; absence means an older host
  // that only renders text, for which steering cannot be offered.
  const agents = mesh?.agents;
  const agentsSummary = mesh?.agentsSummary ?? "";

  const send = async (agentId: string): Promise<void> => {
    const text = (drafts[agentId] ?? "").trim();
    if (text === "" || onSendAgentMessage === undefined) return;
    setPending((p) => ({ ...p, [agentId]: true }));
    try {
      const res = await onSendAgentMessage(agentId, text);
      // A settled child is a structured miss, not a thrown error.
      setNotices((n) => ({
        ...n,
        [agentId]: {
          text: res.error ?? `message queued · ${res.status}`,
          error: res.error !== undefined,
        },
      }));
      if (res.error === undefined) setDrafts((d) => ({ ...d, [agentId]: "" }));
    } catch (err) {
      setNotices((n) => ({
        ...n,
        [agentId]: { text: errorMessage(err), error: true },
      }));
    } finally {
      setPending((p) => ({ ...p, [agentId]: false }));
    }
  };

  const interrupt = async (agentId: string): Promise<void> => {
    if (onInterruptAgent === undefined) return;
    setPending((p) => ({ ...p, [agentId]: true }));
    try {
      const res = await onInterruptAgent(agentId);
      setNotices((n) => ({
        ...n,
        [agentId]: {
          text: res.error ?? `interrupted · ${res.status}`,
          error: res.error !== undefined,
        },
      }));
    } catch (err) {
      setNotices((n) => ({
        ...n,
        [agentId]: { text: errorMessage(err), error: true },
      }));
    } finally {
      setPending((p) => ({ ...p, [agentId]: false }));
    }
  };

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
      {agents !== undefined && agents.length === 0 ? (
        // A modern host reports `agents: []` when there are none; without
        // this the section is simply blank, which reads as "still loading"
        // rather than "nothing spawned yet".
        <p className="muted compact">no sub-agents spawned in this session</p>
      ) : null}
      {agents !== undefined && agents.length > 0 ? (
        <ul className="agent-list" aria-label="Local sub-agents">
          {agents.map((agent) => {
            const reason = steerReason(agent);
            const canSteer = steering && agent.steerable;
            const busy = pending[agent.id] === true;
            const notice = notices[agent.id];
            return (
              <li
                key={agent.id}
                className={`agent-row ${agent.status}`}
              >
                <div className="agent-head">
                  <span className="agent-glyph" aria-hidden="true">
                    {agentGlyph(agent.status)}
                  </span>
                  <span className="mono agent-id" title={agent.id}>
                    {agent.id.slice(0, 8)}
                  </span>
                  <span className="muted">{agent.capabilityTag}</span>
                  <span className={`agent-status ${agent.status}`}>
                    {agent.status}
                  </span>
                </div>
                {agent.objective !== "" ? (
                  <p className="agent-objective">{agent.objective}</p>
                ) : null}
                {agent.status === "running" &&
                agent.outputPreview !== undefined ? (
                  <p
                    className="agent-output muted compact"
                    title={agent.outputPreview}
                  >
                    {lastLine(agent.outputPreview)}
                  </p>
                ) : null}
                {agentMeta(agent) !== "" ? (
                  <p className="muted compact">{agentMeta(agent)}</p>
                ) : null}
                {steering ? (
                  <div className="agent-controls">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void send(agent.id);
                      }}
                    >
                      <input
                        value={drafts[agent.id] ?? ""}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [agent.id]: e.target.value,
                          }))
                        }
                        placeholder="Message child… (Enter)"
                        aria-label={`Message child ${agent.id}`}
                        title={reason || undefined}
                        disabled={busy || !canSteer}
                      />
                      <button
                        type="submit"
                        title={reason || undefined}
                        disabled={
                          busy ||
                          !canSteer ||
                          (drafts[agent.id] ?? "").trim() === ""
                        }
                      >
                        Send
                      </button>
                    </form>
                    <button
                      type="button"
                      title={reason || undefined}
                      aria-label={`Interrupt child ${agent.id}`}
                      disabled={busy || !canSteer}
                      onClick={() => void interrupt(agent.id)}
                    >
                      Interrupt
                    </button>
                    {!agent.steerable && reason !== "" ? (
                      <span className="agent-reason">{reason}</span>
                    ) : null}
                  </div>
                ) : null}
                {notice ? (
                  <p
                    className={`agent-notice${notice.error ? " error" : ""}`}
                    role="status"
                  >
                    {notice.text}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : agents === undefined && agentsSummary !== "" ? (
        // Older host: preformatted text only — display it, no steering.
        <pre className="mesh-agents" title="session/agents">
          {agentsSummary}
        </pre>
      ) : null}
      {mesh.lastDiscovery ? (
        <p className="muted compact">Last event: {mesh.lastDiscovery}</p>
      ) : null}
    </section>
  );
}
