/**
 * browser_* tools — gate, arg validation, mocked session, screenshot multimodal.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  browserClickTool,
  browserCloseTool,
  browserNavigateTool,
  browserScreenshotTool,
  browserSnapshotTool,
  collectSnapshotRefs,
  formatAccessibilityTree,
  setBrowserSessionManager,
  type BrowserPageHandle,
  type BrowserSessionManager,
} from "../../src/tools/builtin/browser/index.js";
import { isMultimodalToolContent } from "../../src/tools/multimodal.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { Session } from "../../src/session.js";

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: "/tmp/spa",
    session: { id: "s1" } as Session,
    abortSignal: new AbortController().signal,
    sandboxPolicy: {
      mode: "workspace-write",
      approval: "on-request",
      backend: "none",
      writableRoots: ["/tmp/spa", "/tmp/spa/.next", "/home/u/.cache/ms-playwright"],
      networkAccess: true,
      slashTmpWritable: true,
    },
    ...overrides,
  };
}

function mockPage(overrides?: Partial<BrowserPageHandle>): BrowserPageHandle {
  const refs = new Map<string, string>();
  return {
    async goto() {},
    async accessibilitySnapshot() {
      return {
        role: "WebArea",
        name: "",
        children: [{ role: "button", name: "Go" }],
      };
    },
    async click() {},
    async type() {},
    async press() {},
    async screenshot() {
      return Buffer.from("fakepng");
    },
    url: () => "http://localhost:5173/",
    setRefs(next) {
      refs.clear();
      for (const r of next) refs.set(r.ref, r.selector);
    },
    resolveRef(ref) {
      return refs.get(ref);
    },
    getConsole: () => [],
    getNetwork: () => [],
    ...overrides,
  };
}

function mockManager(page: BrowserPageHandle): BrowserSessionManager {
  const pages = new Map<string, BrowserPageHandle>();
  return {
    async ensurePage(key) {
      pages.set(key, page);
      return page;
    },
    getPage(key) {
      return pages.get(key);
    },
    async close(key) {
      pages.delete(key);
    },
    async closeAll() {
      pages.clear();
    },
  };
}

afterEach(() => {
  setBrowserSessionManager(undefined);
});

describe("browser_* gate", () => {
  it("refuses without webdev roots / env", async () => {
    const result = await browserNavigateTool.execute(
      { url: "http://localhost:5173" },
      {
        ...ctx(),
        sandboxPolicy: {
          mode: "workspace-write",
          approval: "on-request",
          backend: "none",
          writableRoots: ["/tmp/spa"],
          networkAccess: false,
          slashTmpWritable: true,
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("permission-preset webdev");
  });
});

describe("browser_navigate + snapshot + click", () => {
  it("navigates, snapshots refs, and clicks by ref", async () => {
    const page = mockPage();
    setBrowserSessionManager(mockManager(page));
    const nav = await browserNavigateTool.execute(
      { url: "http://localhost:5173" },
      ctx(),
    );
    expect(nav.isError).toBeUndefined();
    expect(String(nav.content)).toContain("Navigated");

    const snap = await browserSnapshotTool.execute({}, ctx());
    expect(snap.isError).toBeUndefined();
    expect(String(snap.content)).toContain("[ref=e1]");

    const click = await browserClickTool.execute({ ref: "e1" }, ctx());
    expect(click.isError).toBeUndefined();
  });
});

describe("browser_screenshot", () => {
  it("returns multimodal PNG content", async () => {
    const page = mockPage();
    const mgr = mockManager(page);
    setBrowserSessionManager(mgr);
    await mgr.ensurePage("/tmp/spa::s1");
    const result = await browserScreenshotTool.execute({}, ctx());
    expect(result.isError).toBeUndefined();
    expect(isMultimodalToolContent(result.content)).toBe(true);
    if (isMultimodalToolContent(result.content)) {
      expect(result.content.images[0]?.mimeType).toBe("image/png");
      expect(result.content.images[0]?.data.length).toBeGreaterThan(0);
    }
  });
});

describe("browser_close", () => {
  it("closes an open page", async () => {
    const page = mockPage();
    const mgr = mockManager(page);
    setBrowserSessionManager(mgr);
    await mgr.ensurePage("/tmp/spa::s1");
    const result = await browserCloseTool.execute({}, ctx());
    expect(result.isError).toBeUndefined();
    expect(mgr.getPage("/tmp/spa::s1")).toBeUndefined();
  });
});

describe("collectSnapshotRefs", () => {
  it("assigns refs to interactive nodes", () => {
    const tree = {
      role: "WebArea",
      children: [
        { role: "link", name: "Home" },
        { role: "textbox", name: "Email" },
      ],
    };
    const refs = collectSnapshotRefs(tree);
    expect(refs).toHaveLength(2);
    expect(refs[0]?.ref).toBe("e1");
    const formatted = formatAccessibilityTree(tree, refs);
    expect(formatted).toContain("[ref=e1]");
    expect(formatted).toContain("[ref=e2]");
  });

  it("disambiguates duplicate role+name with nth", () => {
    const tree = {
      role: "WebArea",
      children: [
        { role: "button", name: "Submit" },
        { role: "button", name: "Submit" },
      ],
    };
    const refs = collectSnapshotRefs(tree);
    expect(refs).toHaveLength(2);
    expect(refs[0]?.selector).toBe('role=button[name="Submit"]');
    expect(refs[1]?.selector).toBe('role=button[name="Submit"] >> nth=1');
    const formatted = formatAccessibilityTree(tree, refs);
    expect(formatted).toContain("[ref=e1]");
    expect(formatted).toContain("[ref=e2]");
  });
});

describe("resolveHeadedMode", () => {
  it("defaults to headless; keeps prior when opts omit headed", async () => {
    const { resolveHeadedMode, headedModeForEnsure } = await import(
      "../../src/tools/builtin/browser/session.js"
    );
    expect(resolveHeadedMode(undefined, undefined)).toBe(false);
    expect(resolveHeadedMode({}, true)).toBe(true);
    expect(resolveHeadedMode({ headed: false }, true)).toBe(false);
    expect(resolveHeadedMode({ headed: true }, false)).toBe(true);
    expect(headedModeForEnsure(undefined)).toBe(false);
    expect(headedModeForEnsure({ headed: true })).toBe(true);
  });

  it("omits headed on navigate when unset (keeps prior session mode)", async () => {
    const calls: Array<{ headed?: boolean } | undefined> = [];
    const page = mockPage();
    setBrowserSessionManager({
      async ensurePage(_key, opts) {
        calls.push(opts);
        return page;
      },
      getPage: () => page,
      async close() {},
      async closeAll() {},
    });
    await browserNavigateTool.execute(
      { url: "http://localhost:5173", headed: true },
      ctx(),
    );
    await browserNavigateTool.execute({ url: "http://localhost:5173/" }, ctx());
    expect(calls[0]).toEqual({ headed: true });
    expect(calls[1]).toBeUndefined();
  });
});

describe("browser_snapshot aria fallback note", () => {
  it("notes missing refs when tree is ariaSnapshot YAML only", async () => {
    const page = mockPage({
      async accessibilitySnapshot() {
        return { role: "WebArea", name: "", ariaSnapshot: "- heading" };
      },
    });
    const mgr = mockManager(page);
    setBrowserSessionManager(mgr);
    await mgr.ensurePage("/tmp/spa::s1");
    const result = await browserSnapshotTool.execute({}, ctx());
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("Interactive refs: 0");
    expect(String(result.content)).toContain("ariaSnapshot YAML");
  });
});
