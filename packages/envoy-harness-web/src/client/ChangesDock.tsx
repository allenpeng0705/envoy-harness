import type { JSX } from "react";
import { basenameLabel } from "./composer-docks.js";

export interface ChangesDockProps {
  paths: ReadonlyArray<string>;
  onOpenGitDiff: () => void;
  onOpenPath?: (path: string) => void;
  onDismiss?: () => void;
}

export function ChangesDock(props: ChangesDockProps): JSX.Element | null {
  if (props.paths.length === 0) return null;

  return (
    <section className="composer-dock changes-dock" aria-label="Changed files">
      <div className="composer-dock-head">
        <h2>Changes</h2>
        <div className="composer-dock-actions">
          <button type="button" className="linkish" onClick={props.onOpenGitDiff}>
            Open git diff
          </button>
          {props.onDismiss !== undefined ? (
            <button
              type="button"
              className="icon-btn tiny"
              aria-label="Dismiss changes"
              onClick={props.onDismiss}
            >
              ×
            </button>
          ) : null}
        </div>
      </div>
      <ul className="changes-list">
        {props.paths.map((path) => (
          <li key={path}>
            <button
              type="button"
              className="changes-path mono"
              title={path}
              onClick={() => props.onOpenPath?.(path)}
            >
              {basenameLabel(path)}
              <span className="muted changes-path-full">{path}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
