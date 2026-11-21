import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  bootstrapAcpSession,
  writeLastSessionId,
} from "../src/client/acp/host-bootstrap.js";
import type { WsJsonRpcClient } from "../src/client/acp/ws-jsonrpc.js";

function fakeClient(
  handlers: Record<string, (params: unknown) => unknown>,
): WsJsonRpcClient {
  return {
    request: vi.fn(async (method: string, params?: unknown) => {
      const h = handlers[method];
      if (!h) throw new Error(`unexpected ${method}`);
      return h(params);
    }),
  } as unknown as WsJsonRpcClient;
}

const memoryStore = new Map<string, string>();

beforeEach(() => {
  memoryStore.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => memoryStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memoryStore.set(k, v);
    },
    removeItem: (k: string) => {
      memoryStore.delete(k);
    },
  });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bootstrapAcpSession", () => {
  it("loads preferred session when session/load succeeds", async () => {
    const client = fakeClient({
      initialize: () => ({ protocolVersion: 1 }),
      "session/load": () => ({
        sessionId: "s-keep",
        messages: [{ role: "user", text: "hi" }],
      }),
      "discovery/subscribe": () => ({}),
      "config/get": () => ({ cwd: "/tmp" }),
      "session/get_policy": () => ({
        result: {
          sandbox: "workspace-write",
          approval: "on-request",
          autoRun: "always-confirm",
        },
      }),
    });
    const boot = await bootstrapAcpSession(client, {
      preferSessionId: "s-keep",
    });
    expect(boot.sessionId).toBe("s-keep");
    expect(boot.resumed).toBe(true);
    expect(boot.messages?.[0]?.text).toBe("hi");
    expect(client.request).not.toHaveBeenCalledWith(
      "session/new",
      expect.anything(),
    );
  });

  it("resumes the most recent listed session instead of always creating", async () => {
    const client = fakeClient({
      initialize: () => ({ protocolVersion: 1 }),
      "session/load": (params) => {
        const p = params as { sessionId: string };
        if (p.sessionId === "s-old") throw new Error("gone");
        return { sessionId: p.sessionId, messages: [] };
      },
      "session/list": () => ({
        sessions: [
          { id: "s-older", mtimeMs: 1 },
          { id: "s-newest", mtimeMs: 99 },
        ],
      }),
      "discovery/subscribe": () => ({}),
      "config/get": () => ({}),
      "session/get_policy": () => ({}),
    });
    writeLastSessionId("s-old");
    const boot = await bootstrapAcpSession(client);
    expect(boot.sessionId).toBe("s-newest");
    expect(boot.resumed).toBe(true);
    expect(client.request).not.toHaveBeenCalledWith(
      "session/new",
      expect.anything(),
    );
  });

  it("falls back to session/new when nothing can be resumed", async () => {
    const client = fakeClient({
      initialize: () => ({ protocolVersion: 1 }),
      "session/load": () => {
        throw new Error("gone");
      },
      "session/list": () => ({ sessions: [] }),
      "session/new": () => ({ sessionId: "s-new" }),
      "discovery/subscribe": () => ({}),
      "config/get": () => ({}),
      "session/get_policy": () => ({}),
    });
    const boot = await bootstrapAcpSession(client, {
      preferSessionId: "s-missing",
    });
    expect(boot.sessionId).toBe("s-new");
    expect(boot.resumed).toBe(false);
  });
});
