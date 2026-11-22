/**
 * E2E flows for webdev / mobile presets beyond isolated unit tests:
 * ACP slash /preset → get_policy, plan-mode browser gate, session
 * delete closes Playwright, SDK dialect set_policy wire.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  Agent,
  InMemorySession,
  ToolRegistry,
  isWebBrowserAccessAllowed,
  readOnlyPolicyPreservingDomainRoots,
} from "../../src/index.js";
import { HookRegistry } from "../../src/hooks/index.js";
import { createAgentSessionBackend } from "../../src/protocol/agent-backend.js";
import {
  attachAcpServer,
  attachSdkServer,
  createInProcessJsonRpcPair,
} from "../../src/protocol/index.js";
import {
  browserNavigateTool,
  setBrowserSessionManager,
  type BrowserPageHandle,
  type BrowserSessionManager,
} from "../../src/tools/builtin/browser/index.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { Session } from "../../src/session.js";
import { FakeModel, textResponse } from "../fixtures/fake-model.js";

function backendWithRealAgent(cwd: string) {
  return createAgentSessionBackend({
    defaultCwd: cwd,
    createAgent: ({ sessionId, session }) =>
      new Agent({
        model: new FakeModel([textResponse("ok")]),
        tools: new ToolRegistry(),
        hooks: new HookRegistry(),
        session:
          session ??
          new InMemorySession(sessionId, {
            cwd,
            permissionMode: "read-only",
            startedAt: new Date().toISOString(),
          }),
        cwd,
      }),
  });
}

function mockPage(): BrowserPageHandle {
  let url = "about:blank";
  return {
    async goto(next) {
      url = next;
    },
    async accessibilitySnapshot() {
      return { role: "WebArea", name: "", children: [] };
    },
    async click() {},
    async type() {},
    async press() {},
    async screenshot() {
      return Buffer.from("png");
    },
    url: () => url,
    setRefs() {},
    resolveRef() {
      return undefined;
    },
    getConsole() {
      return [];
    },
    getNetwork() {
      return [];
    },
  };
}

afterEach(() => {
  setBrowserSessionManager(undefined);
});

describe("e2e: ACP /preset syncs policy for hosts", () => {
  it("prompt /preset webdev then get_policy sees safe-only autoRun", async () => {
    const backend = backendWithRealAgent("/tmp/spa");
    const { sessionId } = await backend.createSession({ cwd: "/tmp/spa" });

    const slash = await backend.prompt({
      sessionId,
      prompt: { text: "/preset webdev" },
      signal: new AbortController().signal,
      requestPermission: async () => "allow",
    });
    expect(slash.stopReason).toBe("end_turn");
    expect(slash.messages[0]?.text).toMatch(/preset:\s*webdev/i);

    const got = await backend.getPolicy!({ sessionId });
    expect(got.preset).toBe("webdev");
    expect(got.sandbox).toBe("workspace-write");
    expect(got.autoRun).toBe("safe-only");
  });

  it("wire ACP: /preset mobile then set_policy webdev over JSON-RPC", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = backendWithRealAgent("/tmp/app");
    const dispose = attachAcpServer({
      connection: pair.server,
      backend,
    });
    await pair.client.request("initialize", {});
    const { sessionId } = (await pair.client.request("session/new", {
      cwd: "/tmp/app",
    })) as { sessionId: string };

    await pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "/preset mobile" },
    });
    const afterMobile = (await pair.client.request("session/get_policy", {
      sessionId,
    })) as { result: { preset?: string; autoRun?: string } };
    expect(afterMobile.result.preset).toBe("mobile");
    expect(afterMobile.result.autoRun).toBe("safe-only");

    const set = (await pair.client.request("session/set_policy", {
      sessionId,
      preset: "webdev",
      autoRun: "off",
    })) as { result: { preset?: string; autoRun?: string; sandbox?: string } };
    expect(set.result.sandbox).toBe("workspace-write");
    expect(set.result.autoRun).toBe("off");
    expect(set.result.preset).toBeUndefined();

    dispose();
    pair.close();
  });
});

describe("e2e: plan mode keeps webdev browser gate", () => {
  it("navigate succeeds under plan-forced read-only with webdev roots", async () => {
    const page = mockPage();
    const pages = new Map<string, BrowserPageHandle>();
    setBrowserSessionManager({
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
    } satisfies BrowserSessionManager);

    const agent = new Agent({
      model: new FakeModel([textResponse("ok")]),
      tools: new ToolRegistry(),
      hooks: new HookRegistry(),
      session: new InMemorySession("plan-web", {
        cwd: "/tmp/spa",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      cwd: "/tmp/spa",
    });
    agent.setPermissionPreset("webdev");
    agent.setCollaborationMode("plan");

    const policy = readOnlyPolicyPreservingDomainRoots(
      agent.sandboxPolicy,
      "/tmp/spa",
    );
    expect(policy.mode).toBe("read-only");
    expect(isWebBrowserAccessAllowed(policy)).toBe(true);

    const ctx: ToolContext = {
      cwd: "/tmp/spa",
      session: { id: "plan-web" } as Session,
      abortSignal: new AbortController().signal,
      sandboxPolicy: policy,
    };
    const nav = await browserNavigateTool.execute(
      { url: "http://127.0.0.1:5173/" },
      ctx,
    );
    expect(nav.isError).toBeUndefined();
    expect(String(nav.content)).toContain("Navigated");
  });
});

describe("e2e: session delete closes Playwright page", () => {
  it("retireLiveSession via deleteSession drops the session browser key", async () => {
    const closed: string[] = [];
    const pages = new Map<string, BrowserPageHandle>();
    setBrowserSessionManager({
      async ensurePage(key) {
        const page = mockPage();
        pages.set(key, page);
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

    // In-memory store so deleteSession is wired.
    const store = {
      async create(meta: { cwd: string; startedAt: string; permissionMode: string }) {
        const id = `sess-${Math.random().toString(36).slice(2, 10)}`;
        const session = new InMemorySession(id, {
          cwd: meta.cwd,
          startedAt: meta.startedAt,
          permissionMode: meta.permissionMode as "workspace-write",
        });
        return Object.assign(session, {
          close: async () => undefined,
        });
      },
      async load() {
        throw new Error("not used");
      },
      async delete() {
        return true;
      },
      async listSummaries() {
        return [];
      },
    };

    const backend = createAgentSessionBackend({
      defaultCwd: "/tmp/spa",
      sessionStore: store as Parameters<
        typeof createAgentSessionBackend
      >[0]["sessionStore"],
      createAgent: ({ sessionId, session, cwd }) =>
        new Agent({
          model: new FakeModel([textResponse("ok")]),
          tools: new ToolRegistry(),
          hooks: new HookRegistry(),
          session:
            session ??
            new InMemorySession(sessionId, {
              cwd: cwd ?? "/tmp/spa",
              permissionMode: "workspace-write",
              startedAt: new Date().toISOString(),
            }),
          cwd: cwd ?? "/tmp/spa",
        }),
    });

    const { sessionId } = await backend.createSession({ cwd: "/tmp/spa" });
    await backend.setPolicy!({ sessionId, preset: "webdev" });

    const ctx: ToolContext = {
      cwd: "/tmp/spa",
      session: { id: sessionId } as Session,
      abortSignal: new AbortController().signal,
      sandboxPolicy: (
        await import("../../src/config/apply.js")
      ).resolveAgentRuntimeConfig("/tmp/spa", { permissionPreset: "webdev" })
        .sandboxPolicy,
    };
    await browserNavigateTool.execute({ url: "http://127.0.0.1/" }, ctx);
    expect(pages.has(`/tmp/spa::${sessionId}`)).toBe(true);

    const del = await backend.deleteSession!(sessionId);
    expect(del.deleted).toBe(true);

    // retireLiveSession closes asynchronously via dynamic import.
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toContain(`/tmp/spa::${sessionId}`);
    expect(pages.has(`/tmp/spa::${sessionId}`)).toBe(false);
  });
});

describe("e2e: SDK dialect set_policy / get_policy", () => {
  it("session/create → set_policy webdev → get_policy", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = backendWithRealAgent("/tmp/spa");
    attachSdkServer({ connection: pair.server, backend });

    const { sessionId } = (await pair.client.request("session/create", {
      cwd: "/tmp/spa",
    })) as { sessionId: string };

    const set = (await pair.client.request("session/set_policy", {
      sessionId,
      preset: "webdev",
    })) as {
      result: { preset?: string; sandbox?: string; autoRun?: string };
    };
    expect(set.result.preset).toBe("webdev");
    expect(set.result.autoRun).toBe("safe-only");

    const got = (await pair.client.request("session/get_policy", {
      sessionId,
    })) as { result: { preset?: string } };
    expect(got.result.preset).toBe("webdev");

    pair.close();
  });
});
