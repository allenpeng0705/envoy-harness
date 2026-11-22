/**
 * E2E: mobile permission preset through ACP set_policy + device gate.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  InMemorySession,
  ToolRegistry,
  isMobileDeviceAccessAllowed,
  isWebBrowserAccessAllowed,
} from "../../src/index.js";
import { HookRegistry } from "../../src/hooks/index.js";
import { createAgentSessionBackend } from "../../src/protocol/agent-backend.js";
import {
  attachAcpServer,
  createInProcessJsonRpcPair,
} from "../../src/protocol/index.js";
import { FakeModel, textResponse } from "../fixtures/fake-model.js";

function backend(cwd: string) {
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

describe("e2e: mobile permission preset", () => {
  it("wire: set_policy mobile → get_policy + device gate", async () => {
    const pair = createInProcessJsonRpcPair();
    const b = backend("/tmp/flutter-app");
    const dispose = attachAcpServer({
      connection: pair.server,
      backend: b,
    });
    await pair.client.request("initialize", {});
    const { sessionId } = (await pair.client.request("session/new", {
      cwd: "/tmp/flutter-app",
    })) as { sessionId: string };

    const set = (await pair.client.request("session/set_policy", {
      sessionId,
      preset: "mobile",
    })) as {
      result: { preset?: string; sandbox?: string; autoRun?: string };
    };
    expect(set.result.preset).toBe("mobile");
    expect(set.result.sandbox).toBe("workspace-write");
    expect(set.result.autoRun).toBe("safe-only");

    const agent = new Agent({
      model: new FakeModel([textResponse("ok")]),
      tools: new ToolRegistry(),
      hooks: new HookRegistry(),
      session: new InMemorySession("m", {
        cwd: "/tmp/flutter-app",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      cwd: "/tmp/flutter-app",
    });
    agent.setPermissionPreset("mobile");
    expect(isMobileDeviceAccessAllowed(agent.sandboxPolicy)).toBe(true);
    expect(isWebBrowserAccessAllowed(agent.sandboxPolicy)).toBe(false);

    dispose();
    pair.close();
  });

  it("safe → mobile → safe clears device gate", async () => {
    const b = backend("/tmp/app");
    const { sessionId } = await b.createSession({ cwd: "/tmp/app" });
    await b.setPolicy!({ sessionId, preset: "safe" });
    await b.setPolicy!({ sessionId, preset: "mobile" });
    expect((await b.getPolicy!({ sessionId })).preset).toBe("mobile");
    await b.setPolicy!({ sessionId, preset: "safe" });
    const got = await b.getPolicy!({ sessionId });
    expect(got.preset).toBe("safe");
    expect(got.sandbox).toBe("read-only");
  });
});
