import {
  useCallback,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { ChatMessage } from "./acp/host.js";
import { SessionTabsBar, type SessionTabInfo } from "./SessionTabsBar.js";
import { Transcript } from "./Transcript.js";
import {
  splitGridTracks,
  type PaneNode,
  type SplitDirection,
} from "./session-panes.js";

export interface ChatSplitLeafModel {
  leafId: string;
  sessionId: string | null;
  title: string;
  messages: ChatMessage[];
  busy: boolean;
  tabs: ReadonlyArray<SessionTabInfo>;
  empty: ReactNode;
}

export interface ChatSplitProps {
  root: PaneNode;
  focusLeafId: string;
  /** leafId → model */
  leafModels: ReadonlyMap<string, ChatSplitLeafModel>;
  error: string | null;
  showConnectionError: boolean;
  onFocusLeaf: (leafId: string) => void;
  onRatio: (splitId: string, ratio: number) => void;
  onSelectTab: (leafId: string, sessionId: string) => void;
  onCloseTab: (leafId: string, sessionId: string) => void;
  onNewTab: (leafId: string) => void;
  onSplitLeaf: (leafId: string, direction: SplitDirection) => void;
  onUnsplitLeaf: (leafId: string) => void;
  canUnsplit: boolean;
}

function Divider(props: {
  direction: SplitDirection;
  ratio: number;
  onRatio: (ratio: number) => void;
}): JSX.Element {
  const onDividerPointer = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault();
      e.stopPropagation();
      const parent = e.currentTarget.parentElement;
      if (!parent) return;
      const start =
        props.direction === "row" ? e.clientX : e.clientY;
      const startRatio = props.ratio;
      const box = parent.getBoundingClientRect();
      const size = props.direction === "row" ? box.width : box.height;
      const onMove = (ev: PointerEvent): void => {
        if (size <= 0) return;
        const delta =
          props.direction === "row"
            ? ev.clientX - start
            : ev.clientY - start;
        props.onRatio(startRatio + delta / size);
      };
      const onUp = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.classList.remove("col-dragging");
      };
      document.body.classList.add("col-dragging");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [props],
  );

  return (
    <div
      className={`chat-split-divider chat-split-divider-${props.direction}`}
      role="separator"
      aria-orientation={props.direction === "row" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(props.ratio * 100)}
      onPointerDown={onDividerPointer}
    />
  );
}

function LeafPane(props: {
  model: ChatSplitLeafModel;
  focused: boolean;
  error: string | null;
  showConnectionError: boolean;
  canUnsplit: boolean;
  onFocus: () => void;
  onSelectTab: (sessionId: string) => void;
  onCloseTab: (sessionId: string) => void;
  onNewTab: () => void;
  onSplit: (direction: SplitDirection) => void;
  onUnsplit: () => void;
}): JSX.Element {
  const { model } = props;
  return (
    <div
      className={`chat-split-pane${props.focused ? " focused" : ""}`}
      onMouseDown={props.onFocus}
    >
      <div className="chat-split-head">
        <span className="chat-split-title">
          {model.sessionId ? model.title : "Empty pane"}
        </span>
        {model.busy ? <span className="busy">busy</span> : null}
        {props.focused ? (
          <span className="chat-split-focus-badge">focused</span>
        ) : null}
        <div className="chat-split-actions">
          <button
            type="button"
            className="session-split-toggle"
            title="Split right"
            onClick={(e) => {
              e.stopPropagation();
              props.onSplit("row");
            }}
          >
            Split |
          </button>
          <button
            type="button"
            className="session-split-toggle"
            title="Split below"
            onClick={(e) => {
              e.stopPropagation();
              props.onSplit("col");
            }}
          >
            Split —
          </button>
          {props.canUnsplit ? (
            <button
              type="button"
              className="session-split-toggle"
              title="Close this pane"
              onClick={(e) => {
                e.stopPropagation();
                props.onUnsplit();
              }}
            >
              Unsplit
            </button>
          ) : null}
        </div>
      </div>
      <SessionTabsBar
        tabs={model.tabs}
        activeId={model.sessionId}
        onSelect={props.onSelectTab}
        onClose={props.onCloseTab}
        onNew={props.onNewTab}
        compact
      />
      {model.sessionId ? (
        <Transcript
          messages={model.messages}
          busy={model.busy}
          error={props.focused ? props.error : null}
          showConnectionError={props.showConnectionError}
          empty={model.empty}
        />
      ) : (
        <p className="muted side-placeholder chat-split-empty">
          Select a session tab while this pane is focused, or open another
          session from the sidebar.
        </p>
      )}
    </div>
  );
}

function NodeView(props: {
  node: PaneNode;
  focusLeafId: string;
  leafModels: ReadonlyMap<string, ChatSplitLeafModel>;
  error: string | null;
  showConnectionError: boolean;
  canUnsplit: boolean;
  onFocusLeaf: (leafId: string) => void;
  onRatio: (splitId: string, ratio: number) => void;
  onSelectTab: (leafId: string, sessionId: string) => void;
  onCloseTab: (leafId: string, sessionId: string) => void;
  onNewTab: (leafId: string) => void;
  onSplitLeaf: (leafId: string, direction: SplitDirection) => void;
  onUnsplitLeaf: (leafId: string) => void;
}): JSX.Element {
  const { node } = props;
  if (node.kind === "leaf") {
    const model = props.leafModels.get(node.id);
    if (!model) {
      return <div className="chat-split-pane muted">Missing pane</div>;
    }
    return (
      <LeafPane
        model={model}
        focused={props.focusLeafId === node.id}
        error={props.error}
        showConnectionError={props.showConnectionError}
        canUnsplit={props.canUnsplit}
        onFocus={() => props.onFocusLeaf(node.id)}
        onSelectTab={(sid) => props.onSelectTab(node.id, sid)}
        onCloseTab={(sid) => props.onCloseTab(node.id, sid)}
        onNewTab={() => props.onNewTab(node.id)}
        onSplit={(dir) => props.onSplitLeaf(node.id, dir)}
        onUnsplit={() => props.onUnsplitLeaf(node.id)}
      />
    );
  }

  return (
    <div
      className={`chat-split chat-split-${node.direction}`}
      style={splitGridTracks(node.direction, node.ratio)}
    >
      <NodeView {...props} node={node.first} />
      <Divider
        direction={node.direction}
        ratio={node.ratio}
        onRatio={(r) => props.onRatio(node.id, r)}
      />
      <NodeView {...props} node={node.second} />
    </div>
  );
}

export function ChatSplit(props: ChatSplitProps): JSX.Element {
  // Single leaf: no pane chrome / nested tabs (window tab bar owns that).
  if (props.root.kind === "leaf") {
    const model = props.leafModels.get(props.root.id);
    if (!model) {
      return <div className="muted side-placeholder">No session</div>;
    }
    return (
      <Transcript
        messages={model.messages}
        busy={model.busy}
        error={props.error}
        showConnectionError={props.showConnectionError}
        empty={model.empty}
      />
    );
  }

  return (
    <NodeView
      node={props.root}
      focusLeafId={props.focusLeafId}
      leafModels={props.leafModels}
      error={props.error}
      showConnectionError={props.showConnectionError}
      canUnsplit={props.canUnsplit}
      onFocusLeaf={props.onFocusLeaf}
      onRatio={props.onRatio}
      onSelectTab={props.onSelectTab}
      onCloseTab={props.onCloseTab}
      onNewTab={props.onNewTab}
      onSplitLeaf={props.onSplitLeaf}
      onUnsplitLeaf={props.onUnsplitLeaf}
    />
  );
}
