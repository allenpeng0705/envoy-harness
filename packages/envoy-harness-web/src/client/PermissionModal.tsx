import { useEffect, useState, type JSX } from "react";
import type { PermissionPrompt, UserQuestionPrompt } from "./acp/host.js";
import { permissionPreview } from "./transcript-utils.js";

export interface PermissionModalProps {
  permission: PermissionPrompt | null;
  userQuestion: UserQuestionPrompt | null;
  questionDraft: string;
  onQuestionDraft: (v: string) => void;
}

export function PermissionModal(props: PermissionModalProps): JSX.Element | null {
  const [showRaw, setShowRaw] = useState(false);
  const { permission, userQuestion } = props;

  // Reset raw-args disclosure whenever a new permission prompt arrives.
  useEffect(() => {
    setShowRaw(false);
  }, [permission]);

  if (permission) {
    const preview = permissionPreview(permission.args);
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true">
        <div className="modal">
          <h2>Permission</h2>
          <p>
            <strong>{permission.toolName}</strong>
          </p>
          <p>{permission.description}</p>
          {preview.summary.length > 0 ? (
            <ul className="perm-summary">
              {preview.summary.map((line) => (
                <li key={line}>
                  <code>{line}</code>
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            className="linkish"
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "Hide raw args" : "Show raw args"}
          </button>
          {showRaw ? <pre className="args">{preview.raw}</pre> : null}
          <div className="modal-actions">
            <button type="button" onClick={() => permission.resolve("deny")}>
              Deny
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => permission.resolve("allow")}
            >
              Allow
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (userQuestion) {
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true">
        <div className="modal">
          <h2>Question</h2>
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
                value={props.questionDraft}
                onChange={(e) => props.onQuestionDraft(e.target.value)}
                autoFocus
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

  return null;
}
