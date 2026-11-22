/**
 * Browser tool e2e with a mocked Playwright session manager.
 *
 * Hermetic (no Chromium). Full UI-debug loop: navigate → snapshot →
 * click/type → screenshot (multimodal) → console/network → close.
 * Real Chromium stays behind ENVOY_WEB_SMOKE=1 in smoke.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  browserClickTool,
  browserCloseTool,
  browserConsoleTool,
  browserNavigateTool,
  browserNetworkTool,
  browserPressTool,
  browserScreenshotTool,
  browserSnapshotTool,
  browserTypeTool,
  setBrowserSessionManager,
  type BrowserConsoleEntry,
  type BrowserNetworkEntry,
  type BrowserPageHandle,
  type BrowserSessionManager,
  type BrowserSnapshotRef,
} from "../../src/tools/builtin/browser/index.js";
import { isMultimodalToolContent } from "../../src/tools/multimodal.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { Session } from "../../src/session.js";
import { resolveAgentRuntimeConfig } from "../../src/config/apply.js";

function webdevCtx(sessionId = "e2e"): ToolContext {
  const runtime = resolveAgentRuntimeConfig("/tmp/spa", {
    permissionPreset: "webdev",
  });
  return {
    cwd: "/tmp/spa",
    session: { id: sessionId } as Session,
    abortSignal: new AbortController().signal,
    sandboxPolicy: runtime.sandboxPolicy,
  };
}

function mockPage(): BrowserPageHandle & {
  console: BrowserConsoleEntry[];
  network: BrowserNetworkEntry[];
  refs: Map<string, string>;
} {
  const refs = new Map<string, string>();
  const consoleEntries: BrowserConsoleEntry[] = [];
  const networkEntries: BrowserNetworkEntry[] = [];
  let url = "about:blank";
  return {
    refs,
    console: consoleEntries,
    network: networkEntries,
    async goto(next) {
      url = next;
      consoleEntries.push({
        type: "log",
        text: "page loaded",
        timestamp: Date.now(),
      });
      networkEntries.push({
        method: "GET",
        url: next,
        status: 200,
        resourceType: "document",
        timestamp: Date.now(),
      });
    },
    async accessibilitySnapshot() {
      return {
        role: "WebArea",
        name: "",
        children: [
          { role: "textbox", name: "Email" },
          { role: "button", name: "Go" },
        ],
      };
    },
    async click(target) {
      if (target.ref !== undefined && !refs.has(target.ref)) {
        throw new Error(`Unknown ref ${target.ref}`);
      }
    },
    async type(target) {
      if (target.ref !== undefined && !refs.has(target.ref)) {
        throw new Error(`Unknown ref ${target.ref}`);
      }
    },
    async press() {},
    async screenshot() {
      return Buffer.from("png-bytes");
    },
    url: () => url,
    setRefs(next: ReadonlyArray<BrowserSnapshotRef>) {
      refs.clear();
      for (const r of next) refs.set(r.ref, r.selector);
    },
    resolveRef(ref) {
      return refs.get(ref);
    },
    getConsole(limit = 50) {
      return consoleEntries.slice(-limit);
    },
    getNetwork(limit = 50) {
      return networkEntries.slice(-limit);
    },
  };
}

function mockManager(page: BrowserPageHandle): BrowserSessionManager {
  const pages = new Map<string, BrowserPageHandle>();
  const headedByKey = new Map<string, boolean>();
  return {
    async ensurePage(key, opts) {
      const prev = headedByKey.get(key);
      const headed =
        opts?.headed !== undefined ? opts.headed === true : (prev ?? false);
      headedByKey.set(key, headed);
      pages.set(key, page);
      return page;
    },
    getPage(key) {
      return pages.get(key);
    },
    async close(key) {
      pages.delete(key);
      headedByKey.delete(key);
    },
    async closeAll() {
      pages.clear();
      headedByKey.clear();
    },
  };
}

afterEach(() => {
  setBrowserSessionManager(undefined);
});

describe("e2e: browser_* UI-debug loop (mocked Playwright)", () => {
  it("runs navigate → snapshot → act → screenshot → console/network → close", async () => {
    const page = mockPage();
    setBrowserSessionManager(mockManager(page));
    const ctx = webdevCtx();

    const nav = await browserNavigateTool.execute(
      { url: "http://127.0.0.1:5173/" },
      ctx,
    );
    expect(nav.isError).toBeUndefined();
    expect(String(nav.content)).toContain("Navigated");

    const snap = await browserSnapshotTool.execute({}, ctx);
    expect(snap.isError).toBeUndefined();
    expect(String(snap.content)).toContain("[ref=e1]");
    expect(String(snap.content)).toContain("[ref=e2]");

    const typed = await browserTypeTool.execute(
      { ref: "e1", text: "a@b.co", clear: true },
      ctx,
    );
    expect(typed.isError).toBeUndefined();

    const clicked = await browserClickTool.execute({ ref: "e2" }, ctx);
    expect(clicked.isError).toBeUndefined();

    const pressed = await browserPressTool.execute({ key: "Enter" }, ctx);
    expect(pressed.isError).toBeUndefined();

    const shot = await browserScreenshotTool.execute({}, ctx);
    expect(shot.isError).toBeUndefined();
    expect(isMultimodalToolContent(shot.content)).toBe(true);

    const cons = await browserConsoleTool.execute({}, ctx);
    expect(String(cons.content)).toContain("page loaded");

    const net = await browserNetworkTool.execute({}, ctx);
    expect(String(net.content)).toContain("GET 200");

    const closed = await browserCloseTool.execute({}, ctx);
    expect(closed.isError).toBeUndefined();
  });

  it("keeps headed mode across navigate when headed is omitted", async () => {
    const page = mockPage();
    const calls: Array<{ headed?: boolean } | undefined> = [];
    setBrowserSessionManager({
      async ensurePage(_key, opts) {
        calls.push(opts);
        return page;
      },
      getPage: () => page,
      async close() {},
      async closeAll() {},
    });
    const ctx = webdevCtx("headed");
    await browserNavigateTool.execute(
      { url: "http://127.0.0.1:5173/", headed: true },
      ctx,
    );
    await browserNavigateTool.execute(
      { url: "http://127.0.0.1:5173/about" },
      ctx,
    );
    expect(calls[0]).toEqual({ headed: true });
    expect(calls[1]).toBeUndefined();
  });

  it("refuses browser tools without webdev gate", async () => {
    setBrowserSessionManager(mockManager(mockPage()));
    const denied = await browserNavigateTool.execute(
      { url: "http://127.0.0.1/" },
      {
        cwd: "/tmp/spa",
        session: { id: "no" } as Session,
        abortSignal: new AbortController().signal,
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
    expect(denied.isError).toBe(true);
    expect(String(denied.content)).toContain("permission-preset webdev");
  });

  it("notes ariaSnapshot YAML when structured refs are empty", async () => {
    const page = mockPage();
    page.accessibilitySnapshot = async () =>
      ({
        role: "WebArea",
        name: "",
        ariaSnapshot: "- heading \"Hi\"",
      }) as Awaited<ReturnType<BrowserPageHandle["accessibilitySnapshot"]>>;
    setBrowserSessionManager(mockManager(page));
    await browserNavigateTool.execute(
      { url: "http://127.0.0.1/" },
      webdevCtx("aria"),
    );
    const snap = await browserSnapshotTool.execute({}, webdevCtx("aria"));
    expect(snap.isError).toBeUndefined();
    expect(String(snap.content)).toMatch(/ariaSnapshot YAML/i);
  });

  it("isolates pages per session key (no cross-session bleed)", async () => {
    const pageA = mockPage();
    const pageB = mockPage();
    const pages = new Map<string, BrowserPageHandle>();
    const closed: string[] = [];
    setBrowserSessionManager({
      async ensurePage(key) {
        let page = pages.get(key);
        if (!page) {
          page = key.endsWith("::b") ? pageB : pageA;
          pages.set(key, page);
        }
        return page;
      },
      getPage(key) {
        return pages.get(key);
      },
      async close(key) {
        closed.push(key);
        pages.delete(key);
      },
      async closeAll() {
        pages.clear();
      },
    });

    await browserNavigateTool.execute(
      { url: "http://127.0.0.1/a" },
      webdevCtx("a"),
    );
    await browserNavigateTool.execute(
      { url: "http://127.0.0.1/b" },
      webdevCtx("b"),
    );
    expect(pageA.url()).toBe("http://127.0.0.1/a");
    expect(pageB.url()).toBe("http://127.0.0.1/b");
    expect([...pages.keys()].sort()).toEqual([
      "/tmp/spa::a",
      "/tmp/spa::b",
    ]);

    await browserCloseTool.execute({}, webdevCtx("a"));
    expect(closed).toEqual(["/tmp/spa::a"]);
    expect(pages.has("/tmp/spa::a")).toBe(false);
    expect(pages.has("/tmp/spa::b")).toBe(true);
  });
});
