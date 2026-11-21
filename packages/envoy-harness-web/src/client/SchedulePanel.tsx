import { useCallback, useEffect, useState, type JSX } from "react";

export interface ScheduleRow {
  id: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
  recurrence:
    | { kind: "once"; at: string }
    | { kind: "interval"; everyMs: number; nextAt: string };
}

export interface SchedulePanelProps {
  ready: boolean;
  list: () => Promise<{
    schedules: ScheduleRow[];
    enabled: boolean;
    error?: string;
  }>;
  create: (input: {
    prompt: string;
    runAt?: string;
    everyMs?: number;
  }) => Promise<{ schedule?: ScheduleRow; error?: string; enabled: boolean }>;
  tick: () => Promise<{ fired: number; error?: string; enabled: boolean }>;
}

function formatRecurrence(row: ScheduleRow): string {
  const r = row.recurrence;
  if (r.kind === "once") return `once @ ${r.at}`;
  return `every ${r.everyMs}ms · next ${r.nextAt}`;
}

export function SchedulePanel(props: SchedulePanelProps): JSX.Element {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [everyMs, setEveryMs] = useState("");
  const [runAt, setRunAt] = useState("");
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
        setRows(res.schedules);
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
    const text = prompt.trim();
    if (!text || busy) return;
    const every = everyMs.trim() === "" ? undefined : Number(everyMs);
    if (every !== undefined && (!Number.isFinite(every) || every <= 0)) {
      setError("every ms must be a positive number");
      return;
    }
    setBusy(true);
    setError(null);
    void props
      .create({
        prompt: text,
        ...(runAt.trim() ? { runAt: runAt.trim() } : {}),
        ...(every !== undefined ? { everyMs: every } : {}),
      })
      .then((res) => {
        if (res.error) {
          setError(res.error);
          setEnabled(res.enabled);
          return;
        }
        setPrompt("");
        setEveryMs("");
        setRunAt("");
        refresh();
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  const onTick = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void props
      .tick()
      .then((res) => {
        if (res.error) setError(res.error);
        setEnabled(res.enabled);
        refresh();
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  if (!props.ready) {
    return <p className="muted side-placeholder">Schedules wait for a live session…</p>;
  }

  return (
    <div className="ops-panel" aria-label="Schedules">
      <div className="ops-panel-head">
        <h3>Schedules</h3>
        <div className="ops-panel-actions">
          <button type="button" className="linkish" onClick={refresh} disabled={loading}>
            Refresh
          </button>
          <button type="button" className="linkish" onClick={onTick} disabled={busy || !enabled}>
            Tick due
          </button>
        </div>
      </div>
      {!enabled ? (
        <p className="hint">
          Schedules are off on this agent (enable with --schedule / --power).
        </p>
      ) : null}
      {error ? <p className="error-inline">{error}</p> : null}
      <ul className="ops-list">
        {rows.length === 0 ? (
          <li className="muted">{loading ? "Loading…" : "No schedules"}</li>
        ) : (
          rows.map((row) => (
            <li key={row.id} className="ops-item">
              <div className="ops-item-title mono">{row.id}</div>
              <div className="ops-item-body">{row.prompt}</div>
              <div className="ops-item-meta muted">
                {formatRecurrence(row)}
                {row.enabled ? "" : " · disabled"}
                {row.lastFiredAt ? ` · last ${row.lastFiredAt}` : ""}
              </div>
            </li>
          ))
        )}
      </ul>
      <div className="ops-create">
        <label>
          Prompt
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder="What should run…"
          />
        </label>
        <label>
          Run at (ISO, optional)
          <input
            value={runAt}
            onChange={(e) => setRunAt(e.target.value)}
            placeholder="2026-01-01T12:00:00Z"
          />
        </label>
        <label>
          Every ms (optional)
          <input
            value={everyMs}
            onChange={(e) => setEveryMs(e.target.value)}
            placeholder="3600000"
            inputMode="numeric"
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || !enabled || prompt.trim().length === 0}
          onClick={onCreate}
        >
          Create schedule
        </button>
      </div>
    </div>
  );
}
