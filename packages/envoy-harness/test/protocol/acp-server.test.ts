import { describe, expect, it } from "vitest";

import {
  ACP_PROTOCOL_VERSION,
  attachAcpServer,
  createFakeSessionBackend,
  createInProcessJsonRpcPair,
  JsonRpcError,
} from "../../src/protocol/index.js";

describe("ACP server", () => {
  it("initialize → session/new → session/prompt", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = createFakeSessionBackend();
    const dispose = attachAcpServer({
      connection: pair.server,
      backend,
    });

    const init = (await pair.client.request("initialize", {})) as {
      protocolVersion: number;
    };
    expect(init.protocolVersion).toBe(ACP_PROTOCOL_VERSION);

    const created = (await pair.client.request("session/new", {})) as {
      sessionId: string;
    };
    expect(created.sessionId).toMatch(/^sess-/);

    const updates: unknown[] = [];
    pair.client.setNotificationHandler((method, params) => {
      if (method === "session/update") updates.push(params);
    });

    const result = (await pair.client.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: { text: "hello" },
    })) as { stopReason: string; messages: Array<{ text: string }> };

    expect(result.stopReason).toBe("end_turn");
    expect(result.messages.at(-1)?.text).toBe("echo:hello");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(backend.prompts).toEqual([
      { sessionId: created.sessionId, text: "hello" },
    ]);

    dispose();
    pair.close();
  });

  it("rejects session/prompt before initialize", async () => {
    const pair = createInProcessJsonRpcPair();
    attachAcpServer({
      connection: pair.server,
      backend: createFakeSessionBackend(),
    });
    await expect(
      pair.client.request("session/prompt", {
        sessionId: "x",
        prompt: { text: "hi" },
      }),
    ).rejects.toBeInstanceOf(JsonRpcError);
    pair.close();
  });

  it("session/request_permission round-trip", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = createFakeSessionBackend({ permissionTool: "bash" });
    attachAcpServer({ connection: pair.server, backend });

    pair.client.setRequestHandler(async (method, params) => {
      if (method === "session/request_permission") {
        expect(params).toMatchObject({ toolName: "bash" });
        return { decision: "allow" };
      }
      throw new Error(`unexpected ${method}`);
    });

    await pair.client.request("initialize", {});
    const { sessionId } = (await pair.client.request("session/new", {})) as {
      sessionId: string;
    };
    const result = (await pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "run" },
    })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    pair.close();
  });

  it("session/user_question round-trip", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = createFakeSessionBackend({
      userQuestion: {
        prompt: "Continue?",
        options: ["yes", "no"],
        recommendedIndex: 0,
      },
    });
    attachAcpServer({ connection: pair.server, backend });

    pair.client.setRequestHandler(async (method, params) => {
      if (method === "session/user_question") {
        expect(params).toMatchObject({
          prompt: "Continue?",
          options: ["yes", "no"],
          recommendedIndex: 0,
        });
        return { value: "yes", optionIndex: 0, cancelled: false };
      }
      throw new Error(`unexpected ${method}`);
    });

    await pair.client.request("initialize", {});
    const { sessionId } = (await pair.client.request("session/new", {})) as {
      sessionId: string;
    };
    const result = (await pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "ask me" },
    })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(backend.userAnswers).toEqual([
      { value: "yes", optionIndex: 0, cancelled: false },
    ]);
    pair.close();
  });

  it("session/cancel aborts an in-flight prompt", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = createFakeSessionBackend();
    // Slow prompt: wait until cancelled.
    backend.prompt = async (params) => {
      await new Promise<void>((resolve) => {
        if (params.signal.aborted) {
          resolve();
          return;
        }
        params.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return {
        stopReason: "cancelled",
        messages: [{ role: "assistant", text: "cancelled" }],
      };
    };
    attachAcpServer({ connection: pair.server, backend });
    await pair.client.request("initialize", {});
    const { sessionId } = (await pair.client.request("session/new", {})) as {
      sessionId: string;
    };

    const promptPromise = pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "slow" },
    });
    // Let the prompt start.
    await new Promise((r) => setTimeout(r, 10));
    await pair.client.request("session/cancel", { sessionId });
    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe("cancelled");
    expect(backend.cancelled).toContain(sessionId);
    pair.close();
  });
});
