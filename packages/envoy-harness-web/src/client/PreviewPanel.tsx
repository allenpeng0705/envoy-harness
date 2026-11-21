import { useEffect, useMemo, useState, type JSX } from "react";
import type { FsNode } from "./FileTreePanel.js";
import { MarkdownBody } from "./MarkdownBody.js";
import {
  isMarkdownPreview,
  maybePrettyJson,
  numberLines,
  previewLanguage,
} from "./preview-utils.js";

export interface PreviewPanelProps {
  file: FsNode | null;
  readFs: (
    path: string,
  ) => Promise<{
    path: string;
    text?: string;
    truncated?: boolean;
    mime?: string;
    binary?: boolean;
  }>;
  onAttachPath?: (path: string) => void;
}

export function PreviewPanel(props: PreviewPanelProps): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [mime, setMime] = useState<string | undefined>(undefined);
  const [meta, setMeta] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [showMd, setShowMd] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!props.file) {
      setText(null);
      setMime(undefined);
      setMeta(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setCopied(false);
    void props
      .readFs(props.file.path)
      .then((res) => {
        setMime(res.mime);
        if (res.binary) {
          setText(null);
          setMeta("Binary file — preview unavailable");
          return;
        }
        setText(res.text ?? "");
        setMeta(
          [res.mime, res.truncated ? "truncated" : undefined]
            .filter(Boolean)
            .join(" · ") || null,
        );
      })
      .catch((err) => {
        setText(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [props.file, props]);

  const lang = useMemo(
    () =>
      props.file ? previewLanguage(props.file.path, mime) : "text",
    [props.file, mime],
  );

  const displayText = useMemo(() => {
    if (text === null) return null;
    return maybePrettyJson(text, lang);
  }, [text, lang]);

  const lines = useMemo(
    () => (displayText !== null ? numberLines(displayText) : []),
    [displayText],
  );

  if (!props.file) {
    return (
      <p className="muted side-placeholder">
        Select a file in the Files tab to preview.
      </p>
    );
  }

  const mdMode = isMarkdownPreview(lang) && showMd && displayText !== null;

  return (
    <div className="preview-panel">
      <div className="preview-head">
        <span className="mono" title={props.file.path}>
          {props.file.name}
        </span>
        <div className="preview-actions">
          <span className="preview-lang muted">{lang}</span>
          {isMarkdownPreview(lang) && displayText !== null ? (
            <button
              type="button"
              className="linkish"
              onClick={() => setShowMd((v) => !v)}
            >
              {showMd ? "Raw" : "Render"}
            </button>
          ) : null}
          <button
            type="button"
            className="linkish"
            onClick={() => setWrap((v) => !v)}
          >
            {wrap ? "No wrap" : "Wrap"}
          </button>
          {displayText !== null ? (
            <button
              type="button"
              className="linkish"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(displayText)
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                  })
                  .catch(() => undefined);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
          {props.onAttachPath ? (
            <button
              type="button"
              onClick={() => props.onAttachPath?.(props.file!.path)}
            >
              Attach path
            </button>
          ) : null}
        </div>
      </div>
      {meta ? <p className="muted preview-meta">{meta}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {mdMode ? (
        <div className="preview-md">
          <MarkdownBody text={displayText} />
        </div>
      ) : null}
      {displayText !== null && !mdMode ? (
        <div
          className={`preview-code${wrap ? " wrap" : " nowrap"}`}
          role="region"
          aria-label="File preview"
        >
          <table className="preview-lines">
            <tbody>
              {lines.map((row) => (
                <tr key={row.n}>
                  <td className="preview-gutter mono">{row.n}</td>
                  <td className="preview-line mono">{row.text || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
