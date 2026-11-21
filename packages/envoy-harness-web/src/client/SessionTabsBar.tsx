import type { JSX } from "react";
import type { SplitDirection } from "./session-panes.js";

export interface SessionTabInfo {
  id: string;
  title: string;
  busy?: boolean;
}

export interface SessionTabsBarProps {
  tabs: ReadonlyArray<SessionTabInfo>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Compact strip for per-pane tab stacks. */
  compact?: boolean;
  /** Window-level split controls (legacy top bar). */
  splitActive?: boolean;
  onToggleSplit?: () => void;
  onSplitDirection?: (direction: SplitDirection) => void;
  onUnsplitAll?: () => void;
}

export function SessionTabsBar(props: SessionTabsBarProps): JSX.Element | null {
  const hasSplitControls =
    props.onToggleSplit !== undefined ||
    props.onSplitDirection !== undefined ||
    props.onUnsplitAll !== undefined;
  if (props.tabs.length === 0 && !hasSplitControls && !props.compact) {
    return null;
  }

  return (
    <div
      className={`session-tabs-bar${props.compact ? " compact" : ""}`}
      aria-label="Open sessions"
    >
      <button
        type="button"
        className="session-tab-new icon-btn tiny"
        title="New session tab"
        aria-label="New session tab"
        onClick={props.onNew}
      >
        +
      </button>
      {props.onSplitDirection !== undefined ? (
        <>
          <button
            type="button"
            className={`session-split-toggle${props.splitActive ? " active" : ""}`}
            title="Split focused pane right"
            onClick={() => props.onSplitDirection!("row")}
          >
            Split |
          </button>
          <button
            type="button"
            className="session-split-toggle"
            title="Split focused pane below"
            onClick={() => props.onSplitDirection!("col")}
          >
            Split —
          </button>
        </>
      ) : props.onToggleSplit !== undefined ? (
        <button
          type="button"
          className={`session-split-toggle${props.splitActive ? " active" : ""}`}
          title={props.splitActive ? "Exit split view" : "Split view"}
          aria-pressed={props.splitActive === true}
          onClick={props.onToggleSplit}
        >
          {props.splitActive ? "Unsplit" : "Split"}
        </button>
      ) : null}
      {props.onUnsplitAll !== undefined && props.splitActive ? (
        <button
          type="button"
          className="session-split-toggle active"
          title="Collapse to focused pane"
          onClick={props.onUnsplitAll}
        >
          Unsplit all
        </button>
      ) : null}
      <div className="session-tabs" role="tablist">
        {props.tabs.map((tab) => {
          const active = tab.id === props.activeId;
          return (
            <div
              key={tab.id}
              className={`session-tab${active ? " active" : ""}${tab.busy ? " busy" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="session-tab-btn"
                title={tab.id}
                onClick={() => props.onSelect(tab.id)}
              >
                {tab.busy ? (
                  <span className="session-tab-dot" aria-hidden />
                ) : null}
                <span className="session-tab-label">{tab.title}</span>
              </button>
              <button
                type="button"
                className="icon-btn tiny session-tab-close"
                aria-label={`Close tab ${tab.title}`}
                title="Close tab (session kept)"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(tab.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
