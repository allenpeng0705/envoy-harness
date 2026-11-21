import { useEffect, useRef, useState, type JSX } from "react";
import type { UserQuestionPrompt } from "./acp/host.js";

/**
 * Wave 9 / M3 — richer ask_user (recommended, multiline, multi-select).
 * Replaces the thin single-line PermissionModal question UI.
 */

export interface AskUserModalProps {
  userQuestion: UserQuestionPrompt | null;
  questionDraft: string;
  onQuestionDraft: (v: string) => void;
}

export function AskUserModal(props: AskUserModalProps): JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const { userQuestion } = props;
  const [selected, setSelected] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    setSelected(new Set());
    if (userQuestion && !userQuestion.options?.length) {
      if (userQuestion.multiline) areaRef.current?.focus();
      else inputRef.current?.focus();
    }
  }, [userQuestion]);

  useEffect(() => {
    if (!userQuestion) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      userQuestion.resolve({ value: "", cancelled: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [userQuestion]);

  if (!userQuestion) return null;

  const options = userQuestion.options ?? [];
  const multiple = userQuestion.multiple === true;
  const multiline = userQuestion.multiline === true;
  const recommended = userQuestion.recommendedIndex;

  const submitMulti = (): void => {
    const indexes = [...selected].sort((a, b) => a - b);
    const labels = indexes
      .map((i) => options[i])
      .filter((x): x is string => typeof x === "string");
    userQuestion.resolve({
      value: labels.join(", "),
      ...(indexes.length === 1 ? { optionIndex: indexes[0] } : {}),
      ...(indexes.length > 0 ? { optionIndexes: indexes } : {}),
    });
    props.onQuestionDraft("");
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="question-title"
    >
      <div className="modal ask-user-modal">
        <h2 id="question-title">Question</h2>
        <p className="ask-user-prompt">{userQuestion.question}</p>

        {options.length > 0 ? (
          <>
            <ul className={`options${multiple ? " multi" : ""}`}>
              {options.map((opt, i) => {
                const isRec = recommended === i;
                if (multiple) {
                  const checked = selected.has(i);
                  return (
                    <li key={`${i}:${opt}`}>
                      <label
                        className={`ask-option${isRec ? " recommended" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(i)) next.delete(i);
                              else next.add(i);
                              return next;
                            });
                          }}
                        />
                        <span>{opt}</span>
                        {isRec ? (
                          <span className="ask-rec-badge">suggested</span>
                        ) : null}
                      </label>
                    </li>
                  );
                }
                return (
                  <li key={`${i}:${opt}`}>
                    <button
                      type="button"
                      className={isRec ? "recommended" : ""}
                      onClick={() =>
                        userQuestion.resolve({
                          value: opt,
                          optionIndex: i,
                        })
                      }
                    >
                      {opt}
                      {isRec ? (
                        <span className="ask-rec-badge">suggested</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {multiple ? (
              <div className="modal-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={selected.size === 0}
                  onClick={submitMulti}
                >
                  Submit ({selected.size})
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              userQuestion.resolve({ value: props.questionDraft });
              props.onQuestionDraft("");
            }}
          >
            {multiline ? (
              <textarea
                ref={areaRef}
                value={props.questionDraft}
                onChange={(e) => props.onQuestionDraft(e.target.value)}
                aria-label="Your answer"
                rows={5}
              />
            ) : (
              <input
                ref={inputRef}
                value={props.questionDraft}
                onChange={(e) => props.onQuestionDraft(e.target.value)}
                aria-label="Your answer"
              />
            )}
            <button type="submit" className="primary">
              Submit
            </button>
          </form>
        )}
        <button
          type="button"
          className="linkish"
          onClick={() => userQuestion.resolve({ value: "", cancelled: true })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
