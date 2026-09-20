import { describe, expect, it } from "vitest";

import {
  attachSdkServer,
  createFakeSessionBackend,
  createInProcessJsonRpcPair,
} from "../../src/protocol/index.js";

describe("SDK server", () => {
  it("session/create + tools/list + config/get + prompt", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = createFakeSessionBackend({
      config: { model: "fake" },
      tools: [{ name: "read_file", description: "Read a file" }],
    });
    attachSdkServer({ connection: pair.server, backend });

    const events: unknown[] = [];
    pair.client.setNotificationHandler((method, params) => {
      if (method === "session/event") events.push(params);
    });

    const { sessionId } = (await pair.client.request("session/create", {})) as {
      sessionId: string;
    };
    const tools = (await pair.client.request("tools/list", {})) as {
      tools: Array<{ name: string }>;
    };
    expect(tools.tools[0]?.name).toBe("read_file");

    const config = (await pair.client.request("config/get", {})) as {
      model: string;
    };
    expect(config.model).toBe("fake");

    const result = (await pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "sdk-hi" },
    })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(events.length).toBeGreaterThanOrEqual(1);
    pair.close();
  });

  it("session/user_question round-trip", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = createFakeSessionBackend({
      userQuestion: { prompt: "Ship it?", options: ["y", "n"] },
    });
    attachSdkServer({ connection: pair.server, backend });

    pair.client.setRequestHandler(async (method, params) => {
      if (method === "session/user_question") {
        expect(params).toMatchObject({ prompt: "Ship it?" });
        return { value: "y", optionIndex: 0, cancelled: false };
      }
      throw new Error(`unexpected ${method}`);
    });

    const { sessionId } = (await pair.client.request("session/create", {})) as {
      sessionId: string;
    };
    const result = (await pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "go" },
    })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(backend.userAnswers[0]?.value).toBe("y");
    pair.close();
  });

  it("serves workspace + agent control, and says so when unwired", async () => {
    // The SDK dialect must expose the same surface as ACP: a client that
    // speaks SDK should not be a second-class citizen for projects or for
    // steering background children.
    const calls: unknown[] = [];
    const wired = {
      createSession: async () => ({ sessionId: "s1" }),
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: () => undefined,
      listWorkspaces: async () => ({
        workspaces: [{ path: "/p", name: "p", addedAt: "2026-01-01T00:00:00.000Z" }],
      }),
      sendAgentMessage: async (p: unknown) => {
        calls.push(p);
        return { queued: true, status: "running" };
      },
      interruptAgent: async (p: unknown) => {
        calls.push(p);
        return { interrupted: true, status: "failed" };
      },
    } as unknown as Parameters<typeof attachSdkServer>[0]["backend"];

    const pair = createInProcessJsonRpcPair();
    attachSdkServer({ connection: pair.server, backend: wired });
    const listed = (await pair.client.request("workspace/list", {})) as {
      workspaces: Array<{ name: string }>;
    };
    expect(listed.workspaces[0]?.name).toBe("p");
    const sent = (await pair.client.request("session/agent_message", {
      sessionId: "s1",
      agentId: "child-1",
      message: "go",
    })) as { queued: boolean };
    expect(sent.queued).toBe(true);
    expect(calls.at(-1)).toEqual({
      sessionId: "s1",
      agentId: "child-1",
      message: "go",
    });
    pair.close();

    const unwired = createInProcessJsonRpcPair();
    attachSdkServer({
      connection: unwired.server,
      backend: createFakeSessionBackend(),
    });
    await expect(
      unwired.client.request("session/agent_interrupt", {
        sessionId: "s1",
        agentId: "a",
      }),
    ).rejects.toThrow(/not supported/);
    unwired.close();
  });
});
