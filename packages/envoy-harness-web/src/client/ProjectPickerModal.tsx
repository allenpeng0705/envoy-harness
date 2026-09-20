import { useEffect, useRef, useState, type JSX } from "react";
import type { WorkspaceEntry } from "./acp/host.js";

export interface ProjectPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Known projects, most-recently-opened last. */
  workspaces: WorkspaceEntry[];
  /** cwd of the active session, highlighted when it matches a project. */
  activeCwd: string;
  /** Register a directory. Rejects with the server's message on failure. */
  onAdd: (path: string, name: string) => Promise<void>;
  /** Forget a project (never deletes the directory). */
  onRemove: (path: string) => Promise<void>;
  /** Start a new session in the project. */
  onOpen: (path: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ProjectPickerModal(
  props: ProjectPickerModalProps,
): JSX.Element | null {
  const pathRef = useRef<HTMLInputElement>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setError(null);
    pathRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  const add = async (): Promise<void> => {
    const path = pathDraft.trim();
    if (path === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onAdd(path, nameDraft.trim());
      setPathDraft("");
      setNameDraft("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (path: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onRemove(path);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-picker-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="modal project-picker-modal">
        <div className="modal-title-row">
          <h2 id="project-picker-title">Projects</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={props.onClose}
            aria-label="Close project picker"
          >
            ×
          </button>
        </div>
        <p className="hint">
          Add an absolute directory to start sessions there. Removing a
          project only forgets it — the directory is never deleted.
        </p>

        <form
          className="project-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label>
            Directory path
            <input
              ref={pathRef}
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              placeholder="/absolute/path/to/project"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label>
            Display name <span className="muted">(optional)</span>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="defaults to the folder name"
            />
          </label>
          <button
            type="submit"
            className="primary"
            disabled={busy || pathDraft.trim() === ""}
          >
            Add project
          </button>
        </form>

        {error !== null ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        <h3>Known projects</h3>
        {props.workspaces.length === 0 ? (
          <p className="muted compact">No projects registered yet.</p>
        ) : (
          <ul className="project-list">
            {props.workspaces.map((w) => (
              <li
                key={w.path}
                className={w.path === props.activeCwd ? "active" : ""}
              >
                <div className="project-info">
                  <span className="project-name">{w.name}</span>
                  <span className="project-path mono" title={w.path}>
                    {w.path}
                  </span>
                </div>
                <div className="project-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => props.onOpen(w.path)}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove project ${w.name}`}
                    onClick={() => void remove(w.path)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
