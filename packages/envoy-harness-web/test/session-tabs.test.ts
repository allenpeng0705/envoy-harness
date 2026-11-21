import { describe, expect, it } from "vitest";
import {
  closeSessionTab,
  emptySessionTabs,
  openSessionTab,
  pruneSessionTabs,
  readSessionTabs,
  setActiveSessionTab,
  writeSessionTabs,
} from "../src/client/session-tabs.js";

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

describe("session-tabs", () => {
  it("opens and activates a tab", () => {
    const s1 = openSessionTab(emptySessionTabs(), "a");
    expect(s1).toEqual({ openIds: ["a"], activeId: "a" });
    const s2 = openSessionTab(s1, "b");
    expect(s2).toEqual({ openIds: ["a", "b"], activeId: "b" });
    const s3 = openSessionTab(s2, "a");
    expect(s3).toEqual({ openIds: ["a", "b"], activeId: "a" });
  });

  it("ignores empty session ids on open", () => {
    expect(openSessionTab(emptySessionTabs(), "")).toEqual(emptySessionTabs());
  });

  it("closes active tab and selects a neighbor", () => {
    const state = { openIds: ["a", "b", "c"], activeId: "b" };
    expect(closeSessionTab(state, "b")).toEqual({
      openIds: ["a", "c"],
      activeId: "c",
    });
    expect(closeSessionTab(state, "a").activeId).toBe("b");
    expect(closeSessionTab(state, "c")).toEqual({
      openIds: ["a", "b"],
      activeId: "b",
    });
  });

  it("closing the last tab clears activeId", () => {
    expect(closeSessionTab({ openIds: ["a"], activeId: "a" }, "a")).toEqual({
      openIds: [],
      activeId: null,
    });
  });

  it("closing an unknown tab is a no-op", () => {
    const state = { openIds: ["a", "b"], activeId: "a" };
    expect(closeSessionTab(state, "z")).toEqual(state);
  });

  it("closing a non-active tab keeps the active id", () => {
    const state = { openIds: ["a", "b", "c"], activeId: "a" };
    expect(closeSessionTab(state, "b")).toEqual({
      openIds: ["a", "c"],
      activeId: "a",
    });
  });

  it("sets active and ignores unknown ids", () => {
    const state = { openIds: ["a", "b"], activeId: "b" };
    expect(setActiveSessionTab(state, "a").activeId).toBe("a");
    expect(setActiveSessionTab(state, "missing")).toEqual(state);
  });

  it("prunes missing sessions and repairs activeId", () => {
    const state = { openIds: ["a", "b"], activeId: "b" };
    expect(pruneSessionTabs(state, new Set(["a"]))).toEqual({
      openIds: ["a"],
      activeId: "a",
    });
    expect(pruneSessionTabs(state, new Set())).toEqual({
      openIds: [],
      activeId: null,
    });
    expect(pruneSessionTabs(state, new Set(["a", "b"]))).toEqual(state);
  });

  it("round-trips through localStorage and recovers corrupt data", () => {
    withLocalStorage((mem) => {
      expect(readSessionTabs()).toEqual(emptySessionTabs());
      writeSessionTabs({ openIds: ["a", "b"], activeId: "b" });
      expect(readSessionTabs()).toEqual({ openIds: ["a", "b"], activeId: "b" });

      mem.set(
        "eh-web-session-tabs",
        JSON.stringify({ openIds: ["a", "", 3, "b"], activeId: "missing" }),
      );
      expect(readSessionTabs()).toEqual({ openIds: ["a", "b"], activeId: "a" });

      mem.set("eh-web-session-tabs", "{bad");
      expect(readSessionTabs()).toEqual(emptySessionTabs());
    });
  });
});
