import type { JSX } from "react";

import type { UseEhuiPanelOptions } from "./use-ehui-panel.js";
import { useEhuiPanel } from "./use-ehui-panel.js";
import { MEMORY_OPS, MEMORY_OP_LABELS, PLAN_ACTIONS, PLAN_ACTION_LABELS } from "./ehui-constants.js";

export interface EhuiPanelContentProps extends UseEhuiPanelOptions {
  className?: string;
  actionButtonClassName?: string;
  primaryActionButtonClassName?: string;
  inputClassName?: string;
}

export function EhuiPanelContent(props: EhuiPanelContentProps): JSX.Element {
  const {
    className,
    actionButtonClassName = "ehui-action-btn",
    primaryActionButtonClassName = "ehui-action-btn ehui-action-btn--primary",
    inputClassName = "ehui-field",
    panel,
    refreshKey,
    dataSource,
  } = props;

  const state = useEhuiPanel({
    panel,
    dataSource,
    ...(refreshKey !== undefined ? { refreshKey } : {}),
  });
  const {
    body,
    error,
    reloadPanel,
    planAction,
    setPlanAction,
    memoryOp,
    setMemoryOp,
    memoryName,
    setMemoryName,
    memoryBody,
    setMemoryBody,
    gitStaged,
    setGitStaged,
    gitStat,
    setGitStat,
  } = state;

  return (
    <div className={className ?? "ehui-panel-content"} data-ehui-panel={panel}>
      {panel === "plan" ? (
        <div className="ehui-panel-actions">
          {PLAN_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              className={actionButtonClassName}
              onClick={() => setPlanAction(action)}
              aria-pressed={planAction === action}
            >
              {PLAN_ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      ) : null}
      {panel === "memory" ? (
        <div className="ehui-panel-actions ehui-panel-actions--stack">
          <div className="ehui-panel-actions">
            {MEMORY_OPS.map((op) => (
              <button
                key={op}
                type="button"
                className={actionButtonClassName}
                onClick={() => setMemoryOp(op)}
                aria-pressed={memoryOp === op}
              >
                {MEMORY_OP_LABELS[op]}
              </button>
            ))}
          </div>
          <div className="ehui-panel-actions">
            <button
              type="button"
              className={primaryActionButtonClassName}
              onClick={() => void reloadPanel()}
            >
              Run
            </button>
          </div>
          {memoryOp !== "list" ? (
            <input
              type="text"
              className={inputClassName}
              placeholder="memory name"
              value={memoryName}
              onChange={(e) =>
                setMemoryName((e.target as HTMLInputElement).value)
              }
            />
          ) : null}
          {memoryOp === "add" ? (
            <textarea
              className={inputClassName}
              placeholder="memory body"
              value={memoryBody}
              onChange={(e) =>
                setMemoryBody((e.target as HTMLTextAreaElement).value)
              }
              rows={3}
            />
          ) : null}
        </div>
      ) : null}
      {panel === "git-diff" ? (
        <div className="ehui-panel-actions">
          <label className="ehui-checkbox">
            <input
              type="checkbox"
              checked={gitStaged}
              onChange={(e) =>
                setGitStaged((e.target as HTMLInputElement).checked)
              }
            />
            staged
          </label>
          <label className="ehui-checkbox">
            <input
              type="checkbox"
              checked={gitStat}
              onChange={(e) =>
                setGitStat((e.target as HTMLInputElement).checked)
              }
            />
            stat
          </label>
          <button
            type="button"
            className={primaryActionButtonClassName}
            onClick={() => void reloadPanel()}
          >
            Refresh
          </button>
        </div>
      ) : null}
      {error !== undefined ? (
        <pre className="ehui-error">{error}</pre>
      ) : (
        <pre className="ehui-body">{body}</pre>
      )}
    </div>
  );
}
