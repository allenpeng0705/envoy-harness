import type { JSX } from "react";
import { basenameLabel } from "./composer-docks.js";
import { isWebUiScratchCwd, shortPathLabel } from "./path-display.js";

export interface ContextStripProps {
  cwd: string;
  /** When false/undefined, cwd is not a registered project (hide path chrome). */
  cwdIsProject?: boolean;
  attachedNames: ReadonlyArray<string>;
  touchedPaths: ReadonlyArray<string>;
  onOpenPath?: (path: string) => void;
}

export function ContextStrip(props: ContextStripProps): JSX.Element | null {
  const showCwd =
    props.cwd.trim().length > 0 &&
    props.cwdIsProject === true &&
    !isWebUiScratchCwd(props.cwd);
  const hasAttach = props.attachedNames.length > 0;
  const hasTouched = props.touchedPaths.length > 0;
  if (!showCwd && !hasAttach && !hasTouched) return null;

  return (
    <div className="context-strip" aria-label="Prompt context">
      {showCwd ? (
        <span className="context-chip mono" title={props.cwd}>
          cwd {shortPathLabel(props.cwd, 40)}
        </span>
      ) : null}
      {props.attachedNames.map((name) => (
        <span key={`a:${name}`} className="context-chip" title={name}>
          +{name}
        </span>
      ))}
      {props.touchedPaths.slice(0, 6).map((path) => (
        <button
          key={`t:${path}`}
          type="button"
          className="context-chip linkish"
          title={path}
          onClick={() => props.onOpenPath?.(path)}
        >
          {basenameLabel(path)}
        </button>
      ))}
      {props.touchedPaths.length > 6 ? (
        <span className="context-chip muted">
          +{props.touchedPaths.length - 6} more
        </span>
      ) : null}
    </div>
  );
}
