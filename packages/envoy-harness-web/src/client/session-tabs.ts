/**
 * Wave M1 — open session tabs for this browser window (DSH session-tabs parity).
 * Closing a tab never deletes the persisted session.
 */

const TABS_KEY = "eh-web-session-tabs";

export interface SessionTabsState {
  /** Open tab session ids, left-to-right. */
  openIds: string[];
  /** Focused tab; must be in openIds when both non-empty. */
  activeId: string | null;
}

export function emptySessionTabs(): SessionTabsState {
  return { openIds: [], activeId: null };
}

export function readSessionTabs(): SessionTabsState {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw === null) return emptySessionTabs();
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return emptySessionTabs();
    const o = parsed as Record<string, unknown>;
    const openIds = Array.isArray(o.openIds)
      ? o.openIds.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    const activeId =
      typeof o.activeId === "string" && openIds.includes(o.activeId)
        ? o.activeId
        : (openIds[0] ?? null);
    return { openIds, activeId };
  } catch {
    return emptySessionTabs();
  }
}

export function writeSessionTabs(state: SessionTabsState): void {
  try {
    localStorage.setItem(
      TABS_KEY,
      JSON.stringify({
        openIds: state.openIds,
        activeId: state.activeId,
      }),
    );
  } catch {
    // ignore
  }
}

/** Ensure `id` is open and active; preserves order when already present. */
export function openSessionTab(
  state: SessionTabsState,
  id: string,
): SessionTabsState {
  if (id.length === 0) return state;
  const openIds = state.openIds.includes(id)
    ? state.openIds
    : [...state.openIds, id];
  return { openIds, activeId: id };
}

/** Close a tab; activate a neighbor when the active tab closes. */
export function closeSessionTab(
  state: SessionTabsState,
  id: string,
): SessionTabsState {
  const idx = state.openIds.indexOf(id);
  if (idx < 0) return state;
  const openIds = state.openIds.filter((x) => x !== id);
  if (state.activeId !== id) {
    return { openIds, activeId: state.activeId };
  }
  const next = openIds[idx] ?? openIds[idx - 1] ?? null;
  return { openIds, activeId: next };
}

export function setActiveSessionTab(
  state: SessionTabsState,
  id: string,
): SessionTabsState {
  if (!state.openIds.includes(id)) return state;
  return { ...state, activeId: id };
}

/** Drop tabs whose sessions no longer exist on the server. */
export function pruneSessionTabs(
  state: SessionTabsState,
  existingIds: ReadonlySet<string>,
): SessionTabsState {
  const openIds = state.openIds.filter((id) => existingIds.has(id));
  const activeId =
    state.activeId !== null && openIds.includes(state.activeId)
      ? state.activeId
      : (openIds[0] ?? null);
  return { openIds, activeId };
}
