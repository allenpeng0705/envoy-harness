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
  installToolPermissionAskHook,
  JsonRpcError,
} from "../../src/protocol/index.js";
import { HookRegistry } from "../../src/hooks/index.js";
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

  it("rejects frames larger than the cap (DoS hardening)", () => {
    // The decoder caps frame body size so a malicious peer can't
    // claim Content-Length: 99999999999 and force a huge buffer
    // allocation. Override the cap to a tiny value for the test.
    const dec = new FrameDecoder({ maxBytes: 16 });
    const hugeHeader = Buffer.from("Content-Length: 1024\r\n\r\n", "utf8");
    dec.feed(hugeHeader);
    // The cap check fires on take(), not feed() (the buffer has
    // to accumulate the header first).
    expect(() => dec.take()).toThrow(/frame too large/);
  });

  it("rejects malformed Content-Length (no digits)", () => {
    // The regex `(\d+)` requires digits; values like
    // `Content-Length: -1` and `Content-Length: abc` don't match
    // and fall through to the "missing Content-Length" branch.
    const dec = new FrameDecoder();
    dec.feed(Buffer.from("Content-Length: -1\r\n\r\n", "utf8"));
    expect(() => dec.take()).toThrow(/missing Content-Length/);
    const dec2 = new FrameDecoder();
    dec2.feed(Buffer.from("Content-Length: abc\r\n\r\n", "utf8"));
    expect(() => dec2.take()).toThrow(/missing Content-Length/);
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
  it("prompt returns only this-turn messages (not full history)", async () => {
    let turn = 0;
    const backend = createAgentSessionBackend({
      createAgent: () => {
        const history: Array<{ role: string; content: string }> = [];
        const mock = {
          abort() {},
          getMessageCount() {
            return history.length;
          },
          async run(prompt: string) {
            turn += 1;
            history.push({ role: "user", content: prompt });
            history.push({
              role: "assistant",
              content: `reply-${turn}`,
            });
            return {
              messages: [...history],
              stopReason: "end_turn" as const,
              costUsd: 0,
              iterations: 1,
            };
          },
        };
        return mock as unknown as Agent;
      },
    });

    const { sessionId } = await backend.createSession({});
    const r1 = await backend.prompt({
      sessionId,
      text: "first",
      signal: new AbortController().signal,
      requestPermission: async () => "allow",
    });
    expect(r1.messages.map((m) => m.text)).toEqual(["first", "reply-1"]);

    const r2 = await backend.prompt({
      sessionId,
      text: "second",
      signal: new AbortController().signal,
      requestPermission: async () => "allow",
    });
    expect(r2.messages.map((m) => m.text)).toEqual(["second", "reply-2"]);
  });

  it("cancel unblocks an in-flight requestPermission wait", async () => {
    let abortCalls = 0;
    let permissionStarted = false;
    const backend = createAgentSessionBackend({
      createAgent: ({ askHandler }) => {
        const mock = {
          abort() {
            abortCalls += 1;
          },
          getMessageCount() {
            return 0;
          },
          async run(_prompt: string) {
            permissionStarted = true;
            const decision = await askHandler({
              tool: "bash",
              args: { command: "echo hi" },
              question: "Allow bash?",
              signal: new AbortController().signal,
            });
            return {
              messages: [
                {
                  role: "assistant",
                  content: decision.kind === "deny" ? "denied" : "ok",
                },
              ],
              stopReason: "end_turn" as const,
              costUsd: 0,
              iterations: 1,
            };
          },
        };
        return mock as unknown as Agent;
      },
    });

    const { sessionId } = await backend.createSession({});
    const promptPromise = backend.prompt({
      sessionId,
      text: "need-perm",
      signal: new AbortController().signal,
      requestPermission: () =>
        new Promise(() => {
          /* never resolves — cancel must unblock */
        }),
    });
    for (let i = 0; i < 50 && !permissionStarted; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(permissionStarted).toBe(true);
    backend.cancel(sessionId);
    const result = await promptPromise;
    expect(abortCalls).toBeGreaterThanOrEqual(1);
    expect(result.messages.some((m) => m.text === "denied")).toBe(true);
  });

  it("evicts oldest sessions when maxSessions is exceeded", async () => {
    const backend = createAgentSessionBackend({
      maxSessions: 2,
      createAgent: () =>
        ({
          abort() {},
          getMessageCount: () => 0,
          async run(prompt: string) {
            return {
              messages: [{ role: "assistant", content: prompt }],
              stopReason: "end_turn" as const,
              costUsd: 0,
              iterations: 0,
            };
          },
        }) as unknown as Agent,
    });
    const a = await backend.createSession({});
    const b = await backend.createSession({});
    const c = await backend.createSession({});
    await expect(
      backend.prompt({
        sessionId: a.sessionId,
        text: "gone",
        signal: new AbortController().signal,
        requestPermission: async () => "allow",
      }),
    ).rejects.toThrow(/unknown session/);
    const ok = await backend.prompt({
      sessionId: c.sessionId,
      text: "kept",
      signal: new AbortController().signal,
      requestPermission: async () => "allow",
    });
    expect(ok.messages[0]?.text).toBe("kept");
    void b;
  });

});

describe("JsonRpcConnection", () => {
  it("request has a default 30s timeout and rejects when the server never replies", async () => {
    // Regression: a `request()` that never gets a response
    // would hang the host process forever. The connection
    // now applies a 30s default; override with a custom
    // timeout or `Infinity` to disable.
    const pair = createInProcessJsonRpcPair();
    try {
      // Server never replies to `hang-me`.
      pair.server.setRequestHandler(async () => new Promise(() => {}));
      await expect(
        pair.client.request("hang-me", {}, 30),
      ).rejects.toThrow(/timed out after 30ms/);
    } finally {
      pair.close();
    }
  });

  it("request honors a custom timeout override", async () => {
    const pair = createInProcessJsonRpcPair();
    try {
      pair.server.setRequestHandler(async () => new Promise(() => {}));
      await expect(
        pair.client.request("hang-me", {}, 20),
      ).rejects.toThrow(/timed out after 20ms/);
    } finally {
      pair.close();
    }
  });

  it("request with Infinity timeout does not time out", async () => {
    const pair = createInProcessJsonRpcPair();
    try {
      // Server replies after 50ms.
      pair.server.setRequestHandler(
        async () =>
          new Promise((resolve) => setTimeout(() => resolve("late"), 50)),
      );
      const result = await pair.client.request("eventually", {}, Infinity);
      expect(result).toBe("late");
    } finally {
      pair.close();
    }
  });
});

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
      text: "needs-perm",
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
      text: "deny-me",
    })) as { stopReason: string; messages: Array<{ text: string }> };
    expect(result.stopReason).toBe("permission_denied");
    pair.close();
  });
});
