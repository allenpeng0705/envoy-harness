import { useState, type JSX } from "react";
import type { ChatMessage } from "./acp/host.js";
import { permissionPreview } from "./transcript-utils.js";

export interface ToolCardProps {
  message: ChatMessage;
  /** Open by default when running or errored. */
  defaultOpen?: boolean;
}

export function ToolCard(props: ToolCardProps): JSX.Element {
  const tool = props.message.tool;
  const running = tool?.phase === "call" || tool?.phase === "progress";
  const errored = tool?.isError === true;
  const [open, setOpen] = useState(
    props.defaultOpen === true || running || errored,
  );

  if (tool === undefined) {
    return (
      <article className="bubble tool">
        <header>tool</header>
        <pre>{props.message.text}</pre>
      </article>
    );
  }

  const name = tool.toolName ?? "tool";
  const mark =
    tool.phase === "result"
      ? errored
        ? "✗"
        : "✓"
      : tool.phase === "progress"
        ? "…"
        : "⏺";
  const ms =
    tool.durationMs !== undefined ? ` · ${tool.durationMs}ms` : "";
  const title = `${mark} ${name}${ms}`;

  const argsPreview =
    tool.args !== undefined ? permissionPreview(tool.args) : null;
  const body =
    tool.resultPreview?.trim() ||
    (tool.progress !== undefined && tool.progress.length > 0
      ? tool.progress.join("\n")
      : tool.summary);

  return (
    <article
      className={`tool-card${errored ? " error" : ""}${running ? " running" : ""}`}
    >
      <button
        type="button"
        className="tool-card-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-card-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-card-title mono">{title}</span>
        <span className="tool-card-summary muted">{tool.summary}</span>
      </button>
      {open ? (
        <div className="tool-card-body">
          {argsPreview !== null && argsPreview.summary.length > 0 ? (
            <ul className="tool-card-args">
              {argsPreview.summary.map((line) => (
                <li key={line} className="mono">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
          {argsPreview !== null && argsPreview.summary.length === 0 ? (
            <pre className="tool-card-raw">{argsPreview.raw}</pre>
          ) : null}
          {body ? <pre className="tool-card-output">{body}</pre> : null}
        </div>
      ) : null}
    </article>
  );
}
