import type { JSX } from "react";
import type { SessionContextStats } from "./acp/host-types.js";

export interface ContextChromeProps {
  ready: boolean;
  busy: boolean;
  stats: SessionContextStats | null;
  onRefresh: () => void;
  onCompact: () => void;
}

function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function ContextChrome(props: ContextChromeProps): JSX.Element | null {
  if (!props.ready) return null;
  const s = props.stats;

  return (
    <div className="context-chrome" aria-label="Session context">
      <span className="context-chrome-stat mono" title="Messages in transcript">
        {s ? `${s.messageCount} msgs` : "— msgs"}
      </span>
      <span className="context-chrome-stat mono" title="Input / output tokens">
        {s
          ? `${formatTokens(s.inputTokens)}↑ ${formatTokens(s.outputTokens)}↓`
          : "tokens —"}
      </span>
      <span className="context-chrome-stat mono" title="Accumulated cost">
        {s ? formatCost(s.costUsd) : "$—"}
      </span>
      <button
        type="button"
        className="linkish context-chrome-btn"
        onClick={props.onRefresh}
        disabled={props.busy}
      >
        Refresh
      </button>
      <button
        type="button"
        className="linkish context-chrome-btn"
        onClick={props.onCompact}
        disabled={props.busy}
        title="Keep recent turns; drop older context"
      >
        Compact
      </button>
    </div>
  );
}
