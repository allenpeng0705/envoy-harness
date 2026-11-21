import { useEffect, useRef, type JSX } from "react";
import type { UserQuestionPrompt } from "./acp/host.js";

/**
 * Wave 5 — permissions moved to {@link PermissionDock}.
 * This modal remains for `ask_user` / user questions only.
 */

export interface PermissionModalProps {
  userQuestion: UserQuestionPrompt | null;
  questionDraft: string;
  onQuestionDraft: (v: string) => void;
}

export function PermissionModal(props: PermissionModalProps): JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null);
  const { userQuestion } = props;

  useEffect(() => {
    if (userQuestion && !userQuestion.options?.length) {
      inputRef.current?.focus();
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

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="question-title"
    >
      <div className="modal">
        <h2 id="question-title">Question</h2>
        <p>{userQuestion.question}</p>
        {userQuestion.options?.length ? (
          <ul className="options">
            {userQuestion.options.map((opt, i) => (
              <li key={opt}>
                <button
                  type="button"
                  onClick={() =>
                    userQuestion.resolve({
                      value: opt,
                      optionIndex: i,
                    })
                  }
                >
                  {opt}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              userQuestion.resolve({ value: props.questionDraft });
              props.onQuestionDraft("");
            }}
          >
            <input
              ref={inputRef}
              value={props.questionDraft}
              onChange={(e) => props.onQuestionDraft(e.target.value)}
              aria-label="Your answer"
            />
            <button type="submit">Submit</button>
          </form>
        )}
        <button
          type="button"
          className="linkish"
          onClick={() =>
            userQuestion.resolve({ value: "", cancelled: true })
          }
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
