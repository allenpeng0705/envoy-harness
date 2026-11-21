/**
 * M1 panes — nested split layout with per-pane tab stacks (DSH split-screen).
 * Closing a pane or tab never deletes a session; it only clears bindings.
 */

const PANES_KEY = "eh-web-session-panes";

export type SplitDirection = "row" | "col";

export interface PaneLeaf {
  kind: "leaf";
  id: string;
  openIds: string[];
  activeId: string | null;
}

export interface PaneSplit {
  kind: "split";
  id: string;
  direction: SplitDirection;
  /** Fraction of space for `first` (0.2–0.8). */
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface SessionPanesState {
  root: PaneNode;
  focusLeafId: string;
}

let paneIdSeq = 0;

export function newPaneId(prefix = "p"): string {
  paneIdSeq += 1;
  return `${prefix}${paneIdSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

export function makeLeaf(
  activeId: string | null = null,
  openIds?: string[],
  id?: string,
): PaneLeaf {
  const ids =
    openIds !== undefined
      ? openIds.filter((x) => x.length > 0)
      : activeId
        ? [activeId]
        : [];
  const active =
    activeId !== null && ids.includes(activeId) ? activeId : (ids[0] ?? null);
  return { kind: "leaf", id: id ?? newPaneId("leaf"), openIds: ids, activeId: active };
}

export function defaultSessionPanes(
  activeId: string | null = null,
): SessionPanesState {
  const leaf = makeLeaf(activeId);
  return { root: leaf, focusLeafId: leaf.id };
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(0.8, Math.max(0.2, ratio));
}

function parseLeaf(raw: unknown): PaneLeaf | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== "leaf") return null;
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : newPaneId("leaf");
  const openIds = Array.isArray(o.openIds)
    ? o.openIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const activeId =
    typeof o.activeId === "string" && openIds.includes(o.activeId)
      ? o.activeId
      : (openIds[0] ?? null);
  return { kind: "leaf", id, openIds, activeId };
}

function parseNode(raw: unknown): PaneNode | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "leaf") return parseLeaf(raw);
  if (o.kind !== "split") return null;
  const first = parseNode(o.first);
  const second = parseNode(o.second);
  if (!first || !second) return null;
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : newPaneId("split");
  const direction: SplitDirection = o.direction === "col" ? "col" : "row";
  const ratio = typeof o.ratio === "number" ? clampRatio(o.ratio) : 0.5;
  return { kind: "split", id, direction, ratio, first, second };
}

/** Migrate Wave-9 flat 2-up `{ mode, focus, ratio, paneSessionIds }`. */
function migrateLegacy(o: Record<string, unknown>): SessionPanesState | null {
  if (!Array.isArray(o.paneSessionIds) && o.mode !== "split" && o.mode !== "single") {
    return null;
  }
  const ids = Array.isArray(o.paneSessionIds) ? o.paneSessionIds : [];
  const a = typeof ids[0] === "string" && ids[0].length > 0 ? ids[0] : null;
  const b = typeof ids[1] === "string" && ids[1].length > 0 ? ids[1] : null;
  const ratio = typeof o.ratio === "number" ? clampRatio(o.ratio) : 0.5;
  if (o.mode === "split") {
    const left = makeLeaf(a);
    const right = makeLeaf(b);
    const focusLeafId = o.focus === 1 ? right.id : left.id;
    return {
      root: {
        kind: "split",
        id: newPaneId("split"),
        direction: "row",
        ratio,
        first: left,
        second: right,
      },
      focusLeafId,
    };
  }
  return defaultSessionPanes(a);
}

/** Pure parse/migrate for stored JSON (also used by localStorage read). */
export function hydrateSessionPanes(parsed: unknown): SessionPanesState {
  if (parsed === null || typeof parsed !== "object") {
    return defaultSessionPanes();
  }
  const o = parsed as Record<string, unknown>;
  if (o.root !== undefined) {
    const root = parseNode(o.root);
    if (!root) return defaultSessionPanes();
    const leaves = listLeaves(root);
    if (leaves.length === 0) return defaultSessionPanes();
    const focusLeafId =
      typeof o.focusLeafId === "string" &&
      leaves.some((l) => l.id === o.focusLeafId)
        ? o.focusLeafId
        : leaves[0]!.id;
    return { root, focusLeafId };
  }
  return migrateLegacy(o) ?? defaultSessionPanes();
}

export function readSessionPanes(): SessionPanesState {
  try {
    const raw = localStorage.getItem(PANES_KEY);
    if (raw === null) return defaultSessionPanes();
    return hydrateSessionPanes(JSON.parse(raw) as unknown);
  } catch {
    return defaultSessionPanes();
  }
}

export function writeSessionPanes(state: SessionPanesState): void {
  try {
    localStorage.setItem(PANES_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function listLeaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...listLeaves(node.first), ...listLeaves(node.second)];
}

export function findLeaf(node: PaneNode, leafId: string): PaneLeaf | null {
  if (node.kind === "leaf") return node.id === leafId ? node : null;
  return findLeaf(node.first, leafId) ?? findLeaf(node.second, leafId);
}

export function focusedLeaf(state: SessionPanesState): PaneLeaf {
  return findLeaf(state.root, state.focusLeafId) ?? listLeaves(state.root)[0]!;
}

export function focusedPaneSessionId(state: SessionPanesState): string | null {
  return focusedLeaf(state).activeId;
}

export function leafCount(state: SessionPanesState): number {
  return listLeaves(state.root).length;
}

export function isSplitLayout(state: SessionPanesState): boolean {
  return state.root.kind === "split";
}

function replaceLeaf(
  node: PaneNode,
  leafId: string,
  next: PaneNode,
): PaneNode {
  if (node.kind === "leaf") {
    return node.id === leafId ? next : node;
  }
  return {
    ...node,
    first: replaceLeaf(node.first, leafId, next),
    second: replaceLeaf(node.second, leafId, next),
  };
}

function updateLeaf(
  state: SessionPanesState,
  leafId: string,
  updater: (leaf: PaneLeaf) => PaneLeaf,
): SessionPanesState {
  const leaf = findLeaf(state.root, leafId);
  if (!leaf) return state;
  return {
    ...state,
    root: replaceLeaf(state.root, leafId, updater(leaf)),
  };
}

export function setPaneFocus(
  state: SessionPanesState,
  leafId: string,
): SessionPanesState {
  if (!findLeaf(state.root, leafId)) return state;
  return { ...state, focusLeafId: leafId };
}

/** Open/activate a session tab inside a leaf (and focus that leaf). */
export function bindPaneSession(
  state: SessionPanesState,
  leafId: string,
  sessionId: string | null,
): SessionPanesState {
  if (!findLeaf(state.root, leafId)) return state;
  if (sessionId === null || sessionId.length === 0) {
    return setPaneFocus(state, leafId);
  }
  const next = updateLeaf(state, leafId, (leaf) => {
    const openIds = leaf.openIds.includes(sessionId)
      ? leaf.openIds
      : [...leaf.openIds, sessionId];
    return { ...leaf, openIds, activeId: sessionId };
  });
  return { ...next, focusLeafId: leafId };
}

export function bindFocusedPaneSession(
  state: SessionPanesState,
  sessionId: string | null,
): SessionPanesState {
  return bindPaneSession(state, state.focusLeafId, sessionId);
}

export function activateLeafTab(
  state: SessionPanesState,
  leafId: string,
  sessionId: string,
): SessionPanesState {
  if (!findLeaf(state.root, leafId)) return state;
  return updateLeaf({ ...state, focusLeafId: leafId }, leafId, (leaf) => {
    if (!leaf.openIds.includes(sessionId)) return leaf;
    return { ...leaf, activeId: sessionId };
  });
}

/** True when any leaf still has `sessionId` in its tab stack. */
export function sessionOpenInAnyLeaf(
  state: SessionPanesState,
  sessionId: string,
): boolean {
  return listLeaves(state.root).some((leaf) =>
    leaf.openIds.includes(sessionId),
  );
}

/**
 * CSS grid track for a split node (ratio of `first`, 6px divider, remainder).
 * Pure helper for ChatSplit + tests.
 */
export function splitGridTracks(
  direction: SplitDirection,
  ratio: number,
): { gridTemplateColumns?: string; gridTemplateRows?: string } {
  const r = clampRatio(ratio);
  // Avoid IEEE dust (e.g. 1 - 0.8 → 0.199999…) in CSS fr tracks.
  const a = Math.round(r * 1000) / 1000;
  const b = Math.round((1 - r) * 1000) / 1000;
  const track = `minmax(0, ${a}fr) 6px minmax(0, ${b}fr)`;
  return direction === "row"
    ? { gridTemplateColumns: track }
    : { gridTemplateRows: track };
}

export function closeLeafTab(
  state: SessionPanesState,
  leafId: string,
  sessionId: string,
): SessionPanesState {
  return updateLeaf(state, leafId, (leaf) => {
    const idx = leaf.openIds.indexOf(sessionId);
    if (idx < 0) return leaf;
    const openIds = leaf.openIds.filter((x) => x !== sessionId);
    const activeId =
      leaf.activeId !== sessionId
        ? leaf.activeId
        : (openIds[idx] ?? openIds[idx - 1] ?? null);
    return { ...leaf, openIds, activeId };
  });
}

/** Remove a session id from every leaf's tab stack (e.g. after prune). */
export function prunePaneSessions(
  state: SessionPanesState,
  existingIds: ReadonlySet<string>,
): SessionPanesState {
  const leaves = listLeaves(state.root);
  let root = state.root;
  for (const leaf of leaves) {
    const openIds = leaf.openIds.filter((id) => existingIds.has(id));
    if (openIds.length === leaf.openIds.length) continue;
    const activeId =
      leaf.activeId !== null && openIds.includes(leaf.activeId)
        ? leaf.activeId
        : (openIds[0] ?? null);
    root = replaceLeaf(root, leaf.id, { ...leaf, openIds, activeId });
  }
  return { ...state, root };
}

export function setSplitRatio(
  state: SessionPanesState,
  splitId: string,
  ratio: number,
): SessionPanesState {
  const nextRatio = clampRatio(ratio);
  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") return node;
    if (node.id === splitId) return { ...node, ratio: nextRatio };
    return {
      ...node,
      first: walk(node.first),
      second: walk(node.second),
    };
  };
  return { ...state, root: walk(state.root) };
}

/**
 * Split the focused leaf. `first` keeps current tabs; `second` starts with
 * `partnerId` (or empty).
 */
export function splitFocusedLeaf(
  state: SessionPanesState,
  direction: SplitDirection,
  partnerId: string | null,
): SessionPanesState {
  const leaf = focusedLeaf(state);
  const second = makeLeaf(partnerId);
  const split: PaneSplit = {
    kind: "split",
    id: newPaneId("split"),
    direction,
    ratio: 0.5,
    first: leaf,
    second,
  };
  return {
    root: replaceLeaf(state.root, leaf.id, split),
    focusLeafId: leaf.id,
  };
}

/**
 * Close the focused leaf and promote its sibling. No-op when only one leaf.
 */
export function unsplitFocused(state: SessionPanesState): SessionPanesState {
  if (state.root.kind === "leaf") return state;
  const focusId = state.focusLeafId;

  const remove = (node: PaneNode): PaneNode | null => {
    if (node.kind === "leaf") {
      return node.id === focusId ? null : node;
    }
    const first = remove(node.first);
    const second = remove(node.second);
    if (!first && !second) return null;
    if (!first) return second;
    if (!second) return first;
    return { ...node, first, second };
  };

  const root = remove(state.root);
  if (!root) return defaultSessionPanes();
  const leaves = listLeaves(root);
  const focusLeafId =
    leaves.find((l) => l.id === focusId)?.id ?? leaves[0]!.id;
  return { root, focusLeafId };
}

/** Collapse entire layout to the focused leaf's tabs. */
export function collapseToFocused(state: SessionPanesState): SessionPanesState {
  const leaf = focusedLeaf(state);
  return { root: leaf, focusLeafId: leaf.id };
}

/** Prefer another open tab that is not already active in the focused leaf. */
export function pickSplitPartner(
  activeId: string | null,
  openIds: ReadonlyArray<string>,
): string | null {
  for (const id of openIds) {
    if (id !== activeId) return id;
  }
  return null;
}

/** @deprecated Use splitFocusedLeaf — kept for older call sites during migrate. */
export function enterSplit(
  _state: SessionPanesState,
  leftId: string | null,
  rightId: string | null,
): SessionPanesState {
  const leaf = makeLeaf(leftId);
  const right = makeLeaf(rightId);
  return {
    root: {
      kind: "split",
      id: newPaneId("split"),
      direction: "row",
      ratio: 0.5,
      first: leaf,
      second: right,
    },
    focusLeafId: leaf.id,
  };
}

/** @deprecated Use collapseToFocused / unsplitFocused. */
export function exitSplit(state: SessionPanesState): SessionPanesState {
  return collapseToFocused(state);
}

/** @deprecated Flat 2-up ratio — use setSplitRatio with split node id. */
export function setPaneRatio(
  state: SessionPanesState,
  ratio: number,
): SessionPanesState {
  if (state.root.kind !== "split") return state;
  return setSplitRatio(state, state.root.id, ratio);
}
