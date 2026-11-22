/**
 * E2E: ACP session/set_policy + get_policy for mobile / webdev presets.
 *
 * Locks the host contract used by WebUI / TS client / Python SDK:
 * named preset expands roots and round-trips through get_policy.
 */

import { describe, expect, it } from "vitest";

import { createAgentSessionBackend } from "../../src/protocol/agent-backend.js";
import {
  Agent,
  InMemorySession,
  ToolRegistry,
} from "../../src/index.js";
import { HookRegistry } from "../../src/hooks/index.js";
import { isWebBrowserAccessAllowed } from "../../src/permissions/webdev-roots.js";
import { isMobileDeviceAccessAllowed } from "../../src/permissions/mobile-roots.js";
import { FakeModel, textResponse } from "../fixtures/fake-model.js";
import { parseSetPolicyParams } from "../../src/protocol/acp-params.js";
import {
  attachAcpServer,
  createInProcessJsonRpcPair,
} from "../../src/protocol/index.js";
import { JsonRpcError } from "../../src/protocol/types.js";

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

describe("e2e: ACP permission presets (mobile / webdev)", () => {
  it("set_policy webdev expands roots and get_policy returns named preset", async () => {
    const backend = backendWithRealAgent("/tmp/spa");
    const { sessionId } = await backend.createSession({ cwd: "/tmp/spa" });
    const set = await backend.setPolicy!({
      sessionId,
      preset: "webdev",
    });
    expect(set.preset).toBe("webdev");
    expect(set.sandbox).toBe("workspace-write");
    expect(set.approval).toBe("on-request");
    expect(set.autoRun).toBe("safe-only");

    const got = await backend.getPolicy!({ sessionId });
    expect(got.preset).toBe("webdev");
    expect(got.sandbox).toBe("workspace-write");
    expect(got.autoRun).toBe("safe-only");
  });

  it("mobile → webdev switch keeps named preset and flips gate roots", async () => {
    const backend = backendWithRealAgent("/tmp/spa");
    const { sessionId } = await backend.createSession({ cwd: "/tmp/spa" });
    await backend.setPolicy!({ sessionId, preset: "mobile" });
    expect((await backend.getPolicy!({ sessionId })).preset).toBe("mobile");

    await backend.setPolicy!({ sessionId, preset: "webdev" });
    const got = await backend.getPolicy!({ sessionId });
    expect(got.preset).toBe("webdev");

    // Pull the live agent via a no-op prompt path is heavy; re-check through
    // a fresh setPermissionPreset on a mirror agent for gate semantics.
    const agent = new Agent({
      model: new FakeModel([textResponse("ok")]),
      tools: new ToolRegistry(),
      hooks: new HookRegistry(),
      session: new InMemorySession("mirror", {
        cwd: "/tmp/spa",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      cwd: "/tmp/spa",
    });
    agent.setPermissionPreset("mobile");
    expect(isMobileDeviceAccessAllowed(agent.sandboxPolicy)).toBe(true);
    agent.setPermissionPreset("webdev");
    expect(isWebBrowserAccessAllowed(agent.sandboxPolicy)).toBe(true);
    expect(isMobileDeviceAccessAllowed(agent.sandboxPolicy)).toBe(false);
    expect(agent.getPermissionPreset()).toBe("webdev");
  });

  it("autoRun-only set_policy syncs Agent.autoRun so named preset clears", async () => {
    const backend = backendWithRealAgent("/tmp/spa");
    const { sessionId } = await backend.createSession({ cwd: "/tmp/spa" });
    await backend.setPolicy!({ sessionId, preset: "webdev" });
    await backend.setPolicy!({ sessionId, autoRun: "off" });
    const got = await backend.getPolicy!({ sessionId });
    expect(got.autoRun).toBe("off");
    // webdev implies safe-only; diverging autoRun must not keep reporting webdev.
    expect(got.preset).not.toBe("webdev");
  });

  it("set_policy preset + co-sent axes applies preset then overrides", async () => {
    const backend = backendWithRealAgent("/tmp/spa");
    const { sessionId } = await backend.createSession({ cwd: "/tmp/spa" });
    const set = await backend.setPolicy!({
      sessionId,
      preset: "webdev",
      autoRun: "off",
      sandbox: "read-only",
    });
    expect(set.sandbox).toBe("read-only");
    expect(set.autoRun).toBe("off");
    // Axes diverged from webdev → named preset clears in the response.
    expect(set.preset).toBeUndefined();

    const got = await backend.getPolicy!({ sessionId });
    expect(got.sandbox).toBe("read-only");
    expect(got.autoRun).toBe("off");
    expect(got.preset).not.toBe("webdev");
  });

  it("parseSetPolicyParams accepts mobile/webdev and rejects unknown", () => {
    expect(
      parseSetPolicyParams({ sessionId: "s", preset: "webdev" }).preset,
    ).toBe("webdev");
    expect(
      parseSetPolicyParams({ sessionId: "s", preset: "mobile" }).preset,
    ).toBe("mobile");
    expect(() =>
      parseSetPolicyParams({ sessionId: "s", preset: "not-a-preset" }),
    ).toThrow(JsonRpcError);
  });

  it("wire: initialize → session/new → set_policy webdev → get_policy", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = backendWithRealAgent("/tmp/spa");
    const dispose = attachAcpServer({
      connection: pair.server,
      backend,
    });

    await pair.client.request("initialize", {});
    const { sessionId } = (await pair.client.request("session/new", {
      cwd: "/tmp/spa",
    })) as { sessionId: string };

    const set = (await pair.client.request("session/set_policy", {
      sessionId,
      preset: "webdev",
    })) as {
      result: {
        preset?: string;
        sandbox?: string;
        autoRun?: string;
      };
    };
    expect(set.result.preset).toBe("webdev");
    expect(set.result.sandbox).toBe("workspace-write");
    expect(set.result.autoRun).toBe("safe-only");

    const got = (await pair.client.request("session/get_policy", {
      sessionId,
    })) as {
      result: { preset?: string; sandbox?: string };
    };
    expect(got.result.preset).toBe("webdev");
    expect(got.result.sandbox).toBe("workspace-write");

    dispose();
    pair.close();
  });
});
