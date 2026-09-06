import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import type { ChatMessage } from "./acp/host.js";
import { MarkdownBody } from "./MarkdownBody.js";
import { groupTranscript } from "./transcript-utils.js";

export interface TranscriptProps {
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  showConnectionError: boolean;
  empty: ReactNode;
}

function ActivityFold(props: {
  messages: ChatMessage[];
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen === true);
  const n = props.messages.length;
  const label =
    n === 1
      ? props.messages[0]!.text.slice(0, 80)
      : `${n} activity steps`;
  return (
    <article className="bubble activity">
      <button
        type="button"
        className="activity-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="activity-chevron">{open ? "▾" : "▸"}</span>
        <span className="activity-label">{label}</span>
      </button>
      {open ? (
        <ul className="activity-list">
          {props.messages.map((m) => (
            <li key={m.id}>
              <span className="activity-role">{m.role}</span>
              <pre>{m.text}</pre>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function Transcript(props: TranscriptProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const items = groupTranscript(props.messages);

  useEffect(() => {
    const el = ref.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [props.messages, props.busy]);

  return (
    <div
      className="transcript"
      role="log"
      ref={ref}
      onScroll={() => {
        const el = ref.current;
        if (!el) return;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        stickRef.current = dist < 80;
      }}
    >
      {props.messages.length === 0 ? (
        props.empty
      ) : (
        items.map((item) => {
          if (item.kind === "activity") {
            return (
              <ActivityFold
                key={item.id}
                messages={item.messages}
                defaultOpen={item.messages.length <= 2}
              />
            );
          }
          const m = item.message;
          return (
            <article key={m.id} className={`bubble ${m.role}`}>
              <header>{m.role}</header>
              {m.role === "assistant" || m.role === "user" ? (
                <MarkdownBody text={m.text} />
              ) : (
                <pre>{m.text}</pre>
              )}
            </article>
          );
        })
      )}
      {props.busy ? (
        <p className="stream-hint" aria-live="polite">
          Agent working…
        </p>
      ) : null}
      {props.error && props.showConnectionError ? (
        <p className="error">{props.error}</p>
      ) : null}
    </div>
  );
}
