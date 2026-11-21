import { useEffect, useRef, useState, type JSX } from "react";
import type { PermissionPrompt } from "./acp/host.js";
import {
  buildPermissionDiffPreview,
  permissionTargetPath,
  type PermissionDiffPreview,
} from "./permission-diff.js";
import { permissionPreview } from "./transcript-utils.js";

export interface PermissionDockProps {
  permission: PermissionPrompt;
  /** Optional: load on-disk content for write before/after preview. */
  loadBefore?: (path: string) => Promise<string | null>;
}

export function PermissionDock(props: PermissionDockProps): JSX.Element {
  const { permission } = props;
  const [showRaw, setShowRaw] = useState(false);
  const [diff, setDiff] = useState<PermissionDiffPreview | null>(() =>
    buildPermissionDiffPreview(permission.toolName, permission.args),
  );
  const allowRef = useRef<HTMLButtonElement>(null);
  const summary = permissionPreview(permission.args);

  useEffect(() => {
    setShowRaw(false);
    setDiff(buildPermissionDiffPreview(permission.toolName, permission.args));
    allowRef.current?.focus();

    const path = permissionTargetPath(permission.toolName, permission.args);
    if (
      path === undefined ||
      props.loadBefore === undefined ||
      permission.toolName !== "write"
    ) {
      return;
    }
    let cancelled = false;
    void props.loadBefore(path).then((before) => {
      if (cancelled) return;
      setDiff(
        buildPermissionDiffPreview(
          permission.toolName,
          permission.args,
          before ?? undefined,
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [permission, props]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      permission.resolve("deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [permission]);

  return (
    <section
      className="permission-dock"
      role="dialog"
      aria-labelledby="permission-dock-title"
    >
      <div className="permission-dock-head">
        <h2 id="permission-dock-title">Permission</h2>
        <span className="mono permission-dock-tool">{permission.toolName}</span>
      </div>
      {permission.description ? (
        <p className="permission-dock-desc">{permission.description}</p>
      ) : null}

      {summary.summary.length > 0 ? (
        <ul className="perm-summary">
          {summary.summary.map((line) => (
            <li key={line}>
              <code>{line}</code>
            </li>
          ))}
        </ul>
      ) : null}

      {diff !== null ? (
        <div className="permission-diff">
          <div className="permission-diff-title muted">{diff.title}</div>
          <pre className="permission-diff-body mono">{diff.diff}</pre>
        </div>
      ) : null}

      <button
        type="button"
        className="linkish"
        onClick={() => setShowRaw((v) => !v)}
      >
        {showRaw ? "Hide raw args" : "Show raw args"}
      </button>
      {showRaw ? <pre className="args">{summary.raw}</pre> : null}

      <div className="permission-dock-actions">
        <button type="button" onClick={() => permission.resolve("deny")}>
          Deny
        </button>
        <button
          ref={allowRef}
          type="button"
          className="primary"
          onClick={() => permission.resolve("allow")}
        >
          Allow
        </button>
      </div>
      <p className="muted permission-dock-hint">Esc denies · Allow to continue</p>
    </section>
  );
}
