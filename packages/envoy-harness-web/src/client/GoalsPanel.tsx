import { useCallback, useEffect, useState, type JSX } from "react";

export interface GoalRow {
  id: string;
  title: string;
  detail?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalsPanelProps {
  ready: boolean;
  list: () => Promise<{
    goals: GoalRow[];
    enabled: boolean;
    error?: string;
  }>;
  create: (input: {
    title: string;
    detail?: string;
  }) => Promise<{ goal?: GoalRow; error?: string; enabled: boolean }>;
}

export function GoalsPanel(props: GoalsPanelProps): JSX.Element {
  const [rows, setRows] = useState<GoalRow[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback((): void => {
    if (!props.ready) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError(null);
    void props
      .list()
      .then((res) => {
        setRows(res.goals);
        setEnabled(res.enabled);
        if (res.error) setError(res.error);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [props]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onCreate = (): void => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    void props
      .create({
        title: t,
        ...(detail.trim() ? { detail: detail.trim() } : {}),
      })
      .then((res) => {
        if (res.error) {
          setError(res.error);
          setEnabled(res.enabled);
          return;
        }
        setTitle("");
        setDetail("");
        refresh();
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  if (!props.ready) {
    return <p className="muted side-placeholder">Goals wait for a live session…</p>;
  }

  return (
    <div className="ops-panel" aria-label="Goals">
      <div className="ops-panel-head">
        <h3>Goals</h3>
        <button type="button" className="linkish" onClick={refresh} disabled={loading}>
          Refresh
        </button>
      </div>
      {!enabled ? (
        <p className="hint">
          Goals are off on this agent (enable with --goals / --power).
        </p>
      ) : null}
      {error ? <p className="error-inline">{error}</p> : null}
      <ul className="ops-list">
        {rows.length === 0 ? (
          <li className="muted">{loading ? "Loading…" : "No goals"}</li>
        ) : (
          rows.map((row) => (
            <li key={row.id} className="ops-item">
              <div className="ops-item-title">
                <span className="mono">{row.id}</span>
                <span className="ops-status">[{row.status}]</span>
              </div>
              <div className="ops-item-body">{row.title}</div>
              {row.detail ? (
                <div className="ops-item-meta muted">{row.detail}</div>
              ) : null}
            </li>
          ))
        )}
      </ul>
      <div className="ops-create">
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ship Wave 8"
          />
        </label>
        <label>
          Detail (optional)
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={2}
            placeholder="Acceptance notes…"
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || !enabled || title.trim().length === 0}
          onClick={onCreate}
        >
          Create goal
        </button>
      </div>
    </div>
  );
}
