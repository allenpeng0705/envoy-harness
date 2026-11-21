import { describe, expect, it } from "vitest";
import {
  activateLeafTab,
  bindFocusedPaneSession,
  bindPaneSession,
  closeLeafTab,
  collapseToFocused,
  defaultSessionPanes,
  enterSplit,
  exitSplit,
  findLeaf,
  focusedLeaf,
  focusedPaneSessionId,
  hydrateSessionPanes,
  isSplitLayout,
  leafCount,
  listLeaves,
  makeLeaf,
  pickSplitPartner,
  prunePaneSessions,
  readSessionPanes,
  sessionOpenInAnyLeaf,
  setPaneFocus,
  setPaneRatio,
  setSplitRatio,
  splitFocusedLeaf,
  splitGridTracks,
  unsplitFocused,
  writeSessionPanes,
  type PaneSplit,
  type SessionPanesState,
} from "../src/client/session-panes.js";

function withLocalStorage(run: (store: Map<string, string>) => void): void {
  const mem = new Map<string, string>();
  const fake = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
  };
  const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: fake,
  });
  try {
    run(mem);
  } finally {
    if (prev) Object.defineProperty(globalThis, "localStorage", prev);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

function splitTwice(): SessionPanesState {
  let s = defaultSessionPanes("a");
  s = splitFocusedLeaf(s, "row", "b");
  const right = listLeaves(s.root)[1]!;
  s = splitFocusedLeaf(setPaneFocus(s, right.id), "col", "c");
  return s;
}

describe("session-panes defaults + leaf helpers", () => {
  it("defaults to a single leaf", () => {
    const s = defaultSessionPanes("a");
    expect(s.root.kind).toBe("leaf");
    expect(focusedPaneSessionId(s)).toBe("a");
    expect(isSplitLayout(s)).toBe(false);
    expect(leafCount(s)).toBe(1);
  });

  it("defaults with null active session", () => {
    const s = defaultSessionPanes();
    expect(focusedPaneSessionId(s)).toBeNull();
    expect(focusedLeaf(s).openIds).toEqual([]);
  });

  it("makeLeaf filters empty ids and repairs activeId", () => {
    const leaf = makeLeaf("missing", ["", "a", "b"], "fixed-id");
    expect(leaf.id).toBe("fixed-id");
    expect(leaf.openIds).toEqual(["a", "b"]);
    expect(leaf.activeId).toBe("a");
  });

  it("findLeaf returns null for unknown ids", () => {
    const s = defaultSessionPanes("a");
    expect(findLeaf(s.root, "nope")).toBeNull();
    expect(findLeaf(s.root, s.focusLeafId)?.activeId).toBe("a");
  });

  it("focusedLeaf falls back when focusLeafId is stale", () => {
    const s = defaultSessionPanes("a");
    const stale = { ...s, focusLeafId: "ghost" };
    expect(focusedLeaf(stale).activeId).toBe("a");
  });
});

describe("session-panes split / nest / unsplit", () => {
  it("enters and exits split (legacy helpers)", () => {
    const split = enterSplit(defaultSessionPanes("a"), "a", "b");
    expect(isSplitLayout(split)).toBe(true);
    expect(listLeaves(split.root).map((l) => l.activeId)).toEqual(["a", "b"]);
    const single = exitSplit({
      ...split,
      focusLeafId: listLeaves(split.root)[1]!.id,
    });
    expect(isSplitLayout(single)).toBe(false);
    expect(focusedPaneSessionId(single)).toBe("b");
  });

  it("nests splits horizontally and vertically", () => {
    let s = defaultSessionPanes("a");
    s = splitFocusedLeaf(s, "row", "b");
    expect(leafCount(s)).toBe(2);
    expect(s.root.kind).toBe("split");
    if (s.root.kind !== "split") throw new Error("expected split");
    expect(s.root.direction).toBe("row");

    const right = listLeaves(s.root)[1]!;
    s = setPaneFocus(s, right.id);
    s = splitFocusedLeaf(s, "col", "c");
    expect(leafCount(s)).toBe(3);
    expect(listLeaves(s.root).map((l) => l.activeId)).toEqual(["a", "b", "c"]);

    // Nested structure: root row → first=a, second=col(b,c)
    if (s.root.kind !== "split") throw new Error("expected split");
    expect(s.root.first.kind).toBe("leaf");
    expect(s.root.second.kind).toBe("split");
    if (s.root.second.kind === "split") {
      expect(s.root.second.direction).toBe("col");
    }
  });

  it("preserves the original leaf tabs when splitting", () => {
    let s = defaultSessionPanes("a");
    s = bindFocusedPaneSession(s, "x");
    s = bindFocusedPaneSession(s, "y");
    const beforeIds = focusedLeaf(s).openIds.slice();
    s = splitFocusedLeaf(s, "row", "z");
    const first = listLeaves(s.root)[0]!;
    const second = listLeaves(s.root)[1]!;
    expect(first.openIds).toEqual(beforeIds);
    expect(first.activeId).toBe("y");
    expect(second.openIds).toEqual(["z"]);
    expect(s.focusLeafId).toBe(first.id);
  });

  it("splits with a null partner into an empty pane", () => {
    let s = defaultSessionPanes("a");
    s = splitFocusedLeaf(s, "col", null);
    const second = listLeaves(s.root)[1]!;
    expect(second.openIds).toEqual([]);
    expect(second.activeId).toBeNull();
    if (s.root.kind === "split") expect(s.root.direction).toBe("col");
  });

  it("unsplits focused leaf and collapses to focused", () => {
    let s = splitFocusedLeaf(defaultSessionPanes("a"), "row", "b");
    const right = listLeaves(s.root)[1]!;
    s = setPaneFocus(s, right.id);
    s = unsplitFocused(s);
    expect(leafCount(s)).toBe(1);
    expect(focusedPaneSessionId(s)).toBe("a");

    s = splitTwice();
    const keep = focusedLeaf(s);
    s = collapseToFocused(s);
    expect(isSplitLayout(s)).toBe(false);
    expect(s.focusLeafId).toBe(keep.id);
    expect(focusedPaneSessionId(s)).toBe(keep.activeId);
  });

  it("unsplit is a no-op on a single leaf", () => {
    const s = defaultSessionPanes("a");
    expect(unsplitFocused(s)).toEqual(s);
  });

  it("unsplitting a nested leaf promotes the sibling without flattening siblings", () => {
    // Layout: a | (b — c). Unsplit b → a | c
    let s = splitTwice();
    const leaves = listLeaves(s.root);
    expect(leaves.map((l) => l.activeId)).toEqual(["a", "b", "c"]);
    s = unsplitFocused(setPaneFocus(s, leaves[1]!.id));
    expect(listLeaves(s.root).map((l) => l.activeId)).toEqual(["a", "c"]);
    expect(leafCount(s)).toBe(2);
    expect(s.root.kind).toBe("split");
  });

  it("unsplitting the last sibling of a nested split collapses that branch", () => {
    // a | (b — c); unsplit b then unsplit c → single a
    let s = splitTwice();
    const [, b, c] = listLeaves(s.root);
    s = unsplitFocused(setPaneFocus(s, b!.id));
    s = unsplitFocused(setPaneFocus(s, c!.id));
    expect(isSplitLayout(s)).toBe(false);
    expect(focusedPaneSessionId(s)).toBe("a");
  });
});

describe("session-panes focus / bind / tabs", () => {
  it("binds focus and clamps ratio", () => {
    let s = enterSplit(defaultSessionPanes(), "x", null);
    const right = listLeaves(s.root)[1]!;
    s = bindFocusedPaneSession(setPaneFocus(s, right.id), "y");
    expect(focusedPaneSessionId(s)).toBe("y");
    expect(focusedLeaf(s).openIds).toContain("y");
    expect(setPaneFocus(s, listLeaves(s.root)[0]!.id).focusLeafId).toBe(
      listLeaves(s.root)[0]!.id,
    );
    if (s.root.kind !== "split") throw new Error("expected split");
    expect(setSplitRatio(s, s.root.id, 0.05).root).toMatchObject({
      kind: "split",
      ratio: 0.2,
    });
    expect(setPaneRatio(s, 0.95).root).toMatchObject({
      kind: "split",
      ratio: 0.8,
    });
  });

  it("ignores focus / bind / activate for unknown leaf ids", () => {
    const s = defaultSessionPanes("a");
    expect(setPaneFocus(s, "ghost")).toBe(s);
    expect(bindPaneSession(s, "ghost", "z")).toBe(s);
    expect(activateLeafTab(s, "ghost", "a")).toBe(s);
  });

  it("bind with null sessionId only focuses the leaf", () => {
    let s = splitFocusedLeaf(defaultSessionPanes("a"), "row", "b");
    const right = listLeaves(s.root)[1]!;
    s = bindPaneSession(s, right.id, null);
    expect(s.focusLeafId).toBe(right.id);
    expect(findLeaf(s.root, right.id)?.openIds).toEqual(["b"]);
  });

  it("keeps per-pane tab stacks isolated", () => {
    let s = splitFocusedLeaf(defaultSessionPanes("a"), "row", "b");
    const [left, right] = listLeaves(s.root);
    s = bindPaneSession(s, left!.id, "x");
    s = bindPaneSession(s, right!.id, "y");
    expect(findLeaf(s.root, left!.id)?.openIds).toEqual(["a", "x"]);
    expect(findLeaf(s.root, right!.id)?.openIds).toEqual(["b", "y"]);
    expect(sessionOpenInAnyLeaf(s, "x")).toBe(true);
    expect(sessionOpenInAnyLeaf(s, "missing")).toBe(false);
  });

  it("manages per-pane tabs: activate + close neighbors", () => {
    let s = defaultSessionPanes("a");
    s = bindFocusedPaneSession(s, "b");
    s = bindFocusedPaneSession(s, "c");
    expect(focusedLeaf(s).openIds).toEqual(["a", "b", "c"]);
    expect(focusedPaneSessionId(s)).toBe("c");

    s = activateLeafTab(s, s.focusLeafId, "a");
    expect(focusedPaneSessionId(s)).toBe("a");

    // Activate unknown tab is a no-op on content (focus still moves to leaf).
    const before = focusedLeaf(s);
    s = activateLeafTab(s, s.focusLeafId, "zzz");
    expect(focusedLeaf(s).openIds).toEqual(before.openIds);
    expect(focusedPaneSessionId(s)).toBe("a");

    // Close middle tab while active is left neighbor-aware: close b → keep a
    s = activateLeafTab(s, s.focusLeafId, "b");
    s = closeLeafTab(s, s.focusLeafId, "b");
    expect(focusedLeaf(s).openIds).toEqual(["a", "c"]);
    expect(focusedPaneSessionId(s)).toBe("c");

    // Close non-active tab keeps activeId
    s = activateLeafTab(s, s.focusLeafId, "a");
    s = closeLeafTab(s, s.focusLeafId, "c");
    expect(focusedLeaf(s).openIds).toEqual(["a"]);
    expect(focusedPaneSessionId(s)).toBe("a");

    // Close last tab → empty pane
    s = closeLeafTab(s, s.focusLeafId, "a");
    expect(focusedLeaf(s).openIds).toEqual([]);
    expect(focusedPaneSessionId(s)).toBeNull();

    // Closing unknown id is a no-op
    const empty = s;
    expect(closeLeafTab(s, s.focusLeafId, "nope")).toEqual(empty);
  });

  it("closing a tab in one pane does not remove it from another", () => {
    let s = splitFocusedLeaf(defaultSessionPanes("shared"), "row", "shared");
    const [left, right] = listLeaves(s.root);
    // Both panes show "shared"; close in right only.
    s = closeLeafTab(s, right!.id, "shared");
    expect(findLeaf(s.root, left!.id)?.openIds).toEqual(["shared"]);
    expect(findLeaf(s.root, right!.id)?.openIds).toEqual([]);
    expect(sessionOpenInAnyLeaf(s, "shared")).toBe(true);
    s = closeLeafTab(s, left!.id, "shared");
    expect(sessionOpenInAnyLeaf(s, "shared")).toBe(false);
  });

  it("rebinding an already-open tab only activates it", () => {
    let s = defaultSessionPanes("a");
    s = bindFocusedPaneSession(s, "b");
    s = bindFocusedPaneSession(s, "a");
    expect(focusedLeaf(s).openIds).toEqual(["a", "b"]);
    expect(focusedPaneSessionId(s)).toBe("a");
  });
});

describe("session-panes prune + ratio", () => {
  it("prunes missing sessions from every leaf", () => {
    let s = splitFocusedLeaf(defaultSessionPanes("a"), "row", "gone");
    s = bindPaneSession(s, listLeaves(s.root)[0]!.id, "also-gone");
    s = prunePaneSessions(s, new Set(["a"]));
    const leaves = listLeaves(s.root);
    expect(leaves[0]!.openIds).toEqual(["a"]);
    expect(leaves[0]!.activeId).toBe("a");
    expect(leaves[1]!.openIds).toEqual([]);
    expect(leaves[1]!.activeId).toBeNull();
  });

  it("prune is a no-op when all sessions exist", () => {
    const s = splitFocusedLeaf(defaultSessionPanes("a"), "row", "b");
    expect(prunePaneSessions(s, new Set(["a", "b"]))).toEqual(s);
  });

  it("setSplitRatio updates only the targeted nested split", () => {
    let s = splitTwice();
    if (s.root.kind !== "split") throw new Error("expected split");
    const nested = s.root.second as PaneSplit;
    expect(nested.kind).toBe("split");
    s = setSplitRatio(s, nested.id, 0.7);
    if (s.root.kind !== "split") throw new Error("expected split");
    expect(s.root.ratio).toBe(0.5);
    expect((s.root.second as PaneSplit).ratio).toBe(0.7);

    // Unknown split id → unchanged ratios
    const before = s;
    s = setSplitRatio(s, "missing-split", 0.3);
    expect(s).toEqual(before);

    // Non-finite ratio clamps to 0.5
    s = setSplitRatio(s, nested.id, Number.NaN);
    expect((s.root.second as PaneSplit).ratio).toBe(0.5);
  });

  it("setPaneRatio no-ops on a single leaf", () => {
    const s = defaultSessionPanes("a");
    expect(setPaneRatio(s, 0.3)).toEqual(s);
  });

  it("splitGridTracks builds row/col templates and clamps", () => {
    expect(splitGridTracks("row", 0.4)).toEqual({
      gridTemplateColumns: "minmax(0, 0.4fr) 6px minmax(0, 0.6fr)",
    });
    expect(splitGridTracks("col", 0.05)).toEqual({
      gridTemplateRows: "minmax(0, 0.2fr) 6px minmax(0, 0.8fr)",
    });
    expect(splitGridTracks("row", 0.95)).toEqual({
      gridTemplateColumns: "minmax(0, 0.8fr) 6px minmax(0, 0.2fr)",
    });
    // Non-finite → mid default
    expect(splitGridTracks("row", Number.POSITIVE_INFINITY)).toEqual({
      gridTemplateColumns: "minmax(0, 0.5fr) 6px minmax(0, 0.5fr)",
    });
  });

  it("picks a split partner", () => {
    expect(pickSplitPartner("a", ["a", "b", "c"])).toBe("b");
    expect(pickSplitPartner("a", ["a"])).toBeNull();
    expect(pickSplitPartner(null, ["a"])).toBe("a");
    expect(pickSplitPartner("a", [])).toBeNull();
  });
});

describe("session-panes persistence", () => {
  it("hydrates the new nested tree shape and repairs bad focus", () => {
    const leafA = makeLeaf("a", ["a"], "leaf-a");
    const leafB = makeLeaf("b", ["b"], "leaf-b");
    const stored = {
      root: {
        kind: "split",
        id: "split-1",
        direction: "col",
        ratio: 0.33,
        first: leafA,
        second: leafB,
      },
      focusLeafId: "ghost",
    };
    const s = hydrateSessionPanes(stored);
    expect(isSplitLayout(s)).toBe(true);
    expect(s.focusLeafId).toBe("leaf-a");
    if (s.root.kind === "split") {
      expect(s.root.direction).toBe("col");
      expect(s.root.ratio).toBe(0.33);
    }
  });

  it("hydrates nested trees and clamps stored ratios", () => {
    const s = hydrateSessionPanes({
      root: {
        kind: "split",
        id: "s1",
        direction: "row",
        ratio: 9,
        first: { kind: "leaf", id: "l1", openIds: ["a"], activeId: "a" },
        second: {
          kind: "split",
          id: "s2",
          direction: "col",
          ratio: -1,
          first: { kind: "leaf", id: "l2", openIds: ["b"], activeId: "b" },
          second: { kind: "leaf", id: "l3", openIds: ["c"], activeId: "c" },
        },
      },
      focusLeafId: "l3",
    });
    expect(leafCount(s)).toBe(3);
    expect(s.focusLeafId).toBe("l3");
    if (s.root.kind === "split") {
      expect(s.root.ratio).toBe(0.8);
      if (s.root.second.kind === "split") {
        expect(s.root.second.ratio).toBe(0.2);
      }
    }
  });

  it("migrates legacy 2-up shapes (split + single)", () => {
    const split = hydrateSessionPanes({
      mode: "split",
      focus: 1,
      ratio: 0.4,
      paneSessionIds: ["left", "right"],
    });
    expect(isSplitLayout(split)).toBe(true);
    expect(listLeaves(split.root).map((l) => l.activeId)).toEqual([
      "left",
      "right",
    ]);
    expect(focusedPaneSessionId(split)).toBe("right");
    if (split.root.kind === "split") expect(split.root.ratio).toBe(0.4);

    const single = hydrateSessionPanes({
      mode: "single",
      focus: 0,
      ratio: 0.5,
      paneSessionIds: ["only", null],
    });
    expect(isSplitLayout(single)).toBe(false);
    expect(focusedPaneSessionId(single)).toBe("only");
  });

  it("falls back on corrupt / empty payloads", () => {
    expect(hydrateSessionPanes(null).root.kind).toBe("leaf");
    expect(hydrateSessionPanes("nope").root.kind).toBe("leaf");
    expect(hydrateSessionPanes({}).root.kind).toBe("leaf");
    expect(
      hydrateSessionPanes({ root: { kind: "split", first: null } }).root.kind,
    ).toBe("leaf");
    expect(
      hydrateSessionPanes({
        root: { kind: "leaf", id: "x", openIds: [""], activeId: "x" },
      }).root,
    ).toMatchObject({ kind: "leaf", openIds: [], activeId: null });
  });

  it("round-trips through writeSessionPanes / readSessionPanes", () => {
    withLocalStorage(() => {
      const original = splitTwice();
      writeSessionPanes(original);
      const loaded = readSessionPanes();
      expect(loaded.focusLeafId).toBe(original.focusLeafId);
      expect(leafCount(loaded)).toBe(3);
      expect(listLeaves(loaded.root).map((l) => l.activeId)).toEqual(
        listLeaves(original.root).map((l) => l.activeId),
      );
    });
  });

  it("readSessionPanes recovers from invalid JSON and missing key", () => {
    withLocalStorage((mem) => {
      expect(readSessionPanes().root.kind).toBe("leaf");
      mem.set("eh-web-session-panes", "{not-json");
      expect(readSessionPanes().root.kind).toBe("leaf");
    });
  });

  it("JSON.stringify round-trip preserves structure via hydrate", () => {
    const s = splitTwice();
    const again = hydrateSessionPanes(JSON.parse(JSON.stringify(s)));
    expect(again.focusLeafId).toBe(s.focusLeafId);
    expect(listLeaves(again.root).map((l) => [l.id, l.activeId, l.openIds])).toEqual(
      listLeaves(s.root).map((l) => [l.id, l.activeId, l.openIds]),
    );
  });
});
