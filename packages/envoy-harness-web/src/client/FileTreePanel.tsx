import { useCallback, useEffect, useState, type JSX } from "react";

export interface FsNode {
  name: string;
  path: string;
  kind: "file" | "dir";
}

export interface FileTreePanelProps {
  ready: boolean;
  listFs: (path?: string) => Promise<FsNode[]>;
  onOpenFile: (entry: FsNode) => void;
}

export function FileTreePanel(props: FileTreePanelProps): JSX.Element {
  const [root, setRoot] = useState<FsNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FsNode[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadRoot = useCallback((): void => {
    if (!props.ready) {
      setRoot([]);
      return;
    }
    setLoading(true);
    setError(null);
    void props
      .listFs()
      .then((entries) => {
        setRoot(entries);
        setExpanded({});
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [props]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  const toggleDir = (entry: FsNode): void => {
    if (expanded[entry.path] !== undefined) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[entry.path];
        return next;
      });
      return;
    }
    void props
      .listFs(entry.path)
      .then((children) => {
        setExpanded((prev) => ({ ...prev, [entry.path]: children }));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const renderEntries = (entries: FsNode[], depth: number): JSX.Element => (
    <ul className="fs-list" style={{ paddingLeft: depth === 0 ? 0 : 0.75 * depth + "rem" }}>
      {entries.map((e) => (
        <li key={e.path}>
          {e.kind === "dir" ? (
            <button
              type="button"
              className="fs-row"
              onClick={() => toggleDir(e)}
            >
              <span className="fs-icon">{expanded[e.path] ? "▾" : "▸"}</span>
              <span className="mono">{e.name}/</span>
            </button>
          ) : (
            <button
              type="button"
              className="fs-row"
              onClick={() => props.onOpenFile(e)}
            >
              <span className="fs-icon">·</span>
              <span className="mono">{e.name}</span>
            </button>
          )}
          {e.kind === "dir" && expanded[e.path] !== undefined
            ? renderEntries(expanded[e.path]!, depth + 1)
            : null}
        </li>
      ))}
    </ul>
  );

  if (!props.ready) {
    return <p className="muted side-placeholder">Files wait for a live session…</p>;
  }

  return (
    <div className="fs-panel">
      <div className="fs-toolbar">
        <button type="button" onClick={loadRoot} disabled={loading}>
          Refresh
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {loading && root.length === 0 ? (
        <p className="muted">Loading…</p>
      ) : root.length === 0 ? (
        <p className="muted">Empty directory</p>
      ) : (
        renderEntries(root, 0)
      )}
    </div>
  );
}
