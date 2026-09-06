import { describe, expect, it } from "vitest";

import {
  attachAcpServer,
  attachSdkServer,
  createFakeSessionBackend,
  createInProcessJsonRpcPair,
  installToolPermissionAskHook,
} from "../../src/protocol/index.js";
import { HookRegistry } from "../../src/hooks/index.js";

describe("installToolPermissionAskHook", () => {
  it("extracts the tool name from the PreToolUse payload (regression)", async () => {
    // Regression: the handler used to accept the raw `payload: unknown`
    // and read `payload.tool` — but HookRegistry fires the handler with
    // a `HookEvent` (`{ name, payload }`), so `payload.tool` was always
    // undefined and the question silently defaulted to "Allow tool `tool`?".
    const hooks = new HookRegistry();
    const unregister = installToolPermissionAskHook(hooks);
    const decision = await hooks.fire("PreToolUse", { tool: "bash" });
    if (decision.kind !== "ask") {
      throw new Error(`expected ask, got ${decision.kind}`);
    }
    expect(decision.question).toBe("Allow tool `bash`?");
    unregister();
  });

  it("respects shouldAsk (auto-allow false → continue)", async () => {
    const hooks = new HookRegistry();
    installToolPermissionAskHook(hooks, {
      shouldAsk: (tool) => tool !== "read_file",
    });
    const askDecision = await hooks.fire("PreToolUse", { tool: "bash" });
    expect(askDecision.kind).toBe("ask");
    const continueDecision = await hooks.fire("PreToolUse", {
      tool: "read_file",
    });
    expect(continueDecision.kind).toBe("continue");
  });

  it("falls back to 'tool' when the payload is missing the tool field", async () => {
    const hooks = new HookRegistry();
    installToolPermissionAskHook(hooks);
    const decision = await hooks.fire("PreToolUse", { args: {} });
    if (decision.kind !== "ask") {
      throw new Error(`expected ask, got ${decision.kind}`);
    }
    expect(decision.question).toBe("Allow tool `tool`?");
  });
});

describe("permission ask — defensive host response parsing", () => {
  it("ACP server: host returning null defaults to deny (regression)", async () => {
    // The previous acp-server cast `decision.decision` directly,
    // which would NPE if the host returned null. The fix
    // defensively parses and defaults to deny.
    const pair = createInProcessJsonRpcPair();
    const backend = createFakeSessionBackend({ permissionTool: "bash" });
    attachAcpServer({ connection: pair.server, backend });

    pair.client.setRequestHandler(async (method) => {
      if (method === "session/request_permission") {
        return null; // misbehaving host
      }
      throw new Error(`unexpected ${method}`);
    });

    await pair.client.request("initialize", {});
    const { sessionId } = (await pair.client.request("session/new", {})) as {
      sessionId: string;
    };
    const result = (await pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "needs-perm" },
    })) as { stopReason: string; messages: Array<{ text: string }> };
    expect(result.stopReason).toBe("permission_denied");
    expect(result.messages.at(-1)?.text).toMatch(/permission denied/);
    pair.close();
  });

  it("SDK server: host returning { decision: 'deny' } is honored", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = createFakeSessionBackend({ permissionTool: "bash" });
    attachSdkServer({ connection: pair.server, backend });

    pair.client.setRequestHandler(async (method) => {
      if (method === "session/request_permission") {
        return { decision: "deny" };
      }
      throw new Error(`unexpected ${method}`);
    });

    const { sessionId } = (await pair.client.request("session/create", {})) as {
      sessionId: string;
    };
    const result = (await pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "deny-me" },
    })) as { stopReason: string; messages: Array<{ text: string }> };
    expect(result.stopReason).toBe("permission_denied");
    pair.close();
  });
});
