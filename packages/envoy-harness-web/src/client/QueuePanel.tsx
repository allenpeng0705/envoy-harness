import type { JSX } from "react";
import type { PromptContentBlock } from "./attachments.js";

export interface QueuedPrompt {
  text: string;
  content?: PromptContentBlock[];
}

export interface QueuePanelProps {
  items: ReadonlyArray<QueuedPrompt>;
  onRemove: (index: number) => void;
  onClear: () => void;
  onEdit: (index: number) => void;
}

export function QueuePanel(props: QueuePanelProps): JSX.Element | null {
  if (props.items.length === 0) return null;

  return (
    <div className="queue-panel" aria-label="Queued messages">
      <div className="queue-head">
        <span>
          {props.items.length} queued
        </span>
        <button type="button" className="linkish" onClick={props.onClear}>
          clear all
        </button>
      </div>
      <ol className="queue-list">
        {props.items.map((item, i) => {
          const text = item.text;
          return (
          <li key={`${i}:${text.slice(0, 24)}`} className="queue-item">
            <button
              type="button"
              className="queue-text"
              title="Edit in composer"
              onClick={() => props.onEdit(i)}
            >
              {text.length > 120 ? `${text.slice(0, 117)}…` : text}
            </button>
            <button
              type="button"
              className="icon-btn tiny"
              aria-label={`Remove queued message ${i + 1}`}
              onClick={() => props.onRemove(i)}
            >
              ×
            </button>
          </li>
          );
        })}
      </ol>
    </div>
  );
}
