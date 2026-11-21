import { describe, expect, it, vi } from "vitest";
import { bootstrapAcpSession } from "../src/client/acp/host-bootstrap.js";
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
    expect(client.request).not.toHaveBeenCalledWith("session/new", expect.anything());
  });

  it("falls back to session/new when load fails", async () => {
    const client = fakeClient({
      initialize: () => ({ protocolVersion: 1 }),
      "session/load": () => {
        throw new Error("gone");
      },
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
