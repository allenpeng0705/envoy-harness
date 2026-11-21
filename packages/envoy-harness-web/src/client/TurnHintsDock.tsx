import type { JSX } from "react";
import {
  hasTurnHints,
  type TurnHints,
} from "./composer-docks.js";

export interface TurnHintsDockProps {
  hints: TurnHints | null;
  onFollowUp: (text: string) => void;
  onDismiss?: () => void;
}

export function TurnHintsDock(props: TurnHintsDockProps): JSX.Element | null {
  if (!hasTurnHints(props.hints)) return null;
  const followUps = props.hints.followUps ?? [];
  const deferred = props.hints.deferred ?? [];

  return (
    <section className="composer-dock turn-hints-dock" aria-label="Turn hints">
      <div className="composer-dock-head">
        <h2>Suggested next</h2>
        {props.onDismiss !== undefined ? (
          <button
            type="button"
            className="icon-btn tiny"
            aria-label="Dismiss turn hints"
            onClick={props.onDismiss}
          >
            ×
          </button>
        ) : null}
      </div>
      {followUps.length > 0 ? (
        <ul className="turn-hints-list">
          {followUps.map((text) => (
            <li key={text}>
              <button
                type="button"
                className="turn-hint-btn"
                onClick={() => props.onFollowUp(text)}
              >
                {text}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {deferred.length > 0 ? (
        <div className="turn-deferred">
          <p className="muted turn-deferred-label">Deferred</p>
          <ul className="turn-hints-list">
            {deferred.map((d) => (
              <li key={`${d.task}:${d.reason}`}>
                <button
                  type="button"
                  className="turn-hint-btn deferred"
                  title={d.reason}
                  onClick={() => props.onFollowUp(d.task)}
                >
                  <span>{d.task}</span>
                  <span className="muted">{d.reason}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
