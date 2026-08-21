/**
 * Phase E — ACP + SDK protocol tests (hermetic, in-process).
 */

import { describe, expect, it } from "vitest";

import {
  ACP_PROTOCOL_VERSION,
  attachAcpServer,
  attachSdkServer,
  createAgentSessionBackend,
  createFakeSessionBackend,
  createInProcessJsonRpcPair,
  encodeFrame,
  FrameDecoder,
  JsonRpcError,
} from "../../src/protocol/index.js";
import type { Agent } from "../../src/agent.js";

describe("framing", () => {
  it("round-trips a JSON-RPC message", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "ping", params: { x: 1 } };
    const framed = encodeFrame(msg);
    const dec = new FrameDecoder();
    dec.feed(framed);
    expect(dec.take()).toEqual([msg]);
  });

  it("handles chunked frames", () => {
    const msg = { jsonrpc: "2.0", id: 2, result: "ok" };
    const framed = encodeFrame(msg);
    const dec = new FrameDecoder();
    dec.feed(framed.subarray(0, 10));
    expect(dec.take()).toEqual([]);
    dec.feed(framed.subarray(10));
    expect(dec.take()).toEqual([msg]);
  });
});

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
      text: "hello",
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
        text: "hi",
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
      text: "run",
    })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
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
      text: "slow",
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
      text: "sdk-hi",
    })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(events.length).toBeGreaterThanOrEqual(1);
    pair.close();
  });
});

describe("createAgentSessionBackend", () => {
  it("cancel calls agent.abort (not only a local AbortController)", async () => {
    let abortCalls = 0;
    const backend = createAgentSessionBackend({
      createAgent: () => {
        const mock = {
          abort() {
            abortCalls += 1;
          },
          async run(_prompt: string) {
            await new Promise<void>((resolve) => {
              // Stay in-flight until cancel aborts via agent.abort().
              const tick = setInterval(() => {
                if (abortCalls > 0) {
                  clearInterval(tick);
                  resolve();
                }
              }, 5);
            });
            return {
              messages: [{ role: "assistant", content: "stopped" }],
              stopReason: "aborted" as const,
              costUsd: 0,
              iterations: 0,
            };
          },
        };
        return mock as unknown as Agent;
      },
    });

    const { sessionId } = await backend.createSession({});
    const ac = new AbortController();
    const promptPromise = backend.prompt({
      sessionId,
      text: "slow",
      signal: ac.signal,
      requestPermission: async () => "allow",
    });
    await new Promise((r) => setTimeout(r, 15));
    backend.cancel(sessionId);
    const result = await promptPromise;
    expect(abortCalls).toBeGreaterThanOrEqual(1);
    expect(result.stopReason).toBe("aborted");
  });
});
