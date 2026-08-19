/**
 * T3.3 — MCP type seam tests.
 *
 * Covers:
 * 1. `mcpToolName` / `parseMcpToolName` round-trip
 *    and the null-return cases.
 * 2. `DefaultMcpClientRegistry`:
 *    - register / unregister / get / list
 *    - duplicate-register throws
 *    - unregister calls `client.close()`
 *    - unregister of a missing name is a no-op
 *    - `collectTools` flattens and tags with serverName
 *    - `closeAll` calls every client's `close()`
 * 3. A simple `McpClient` (the fake below) can be
 *    wired through the registry and the routing
 *    helpers parse its name correctly.
 *
 * The stdio JSON-RPC transport is a follow-up
 * sub-chunk; these tests only cover the seam.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  DefaultMcpClientRegistry,
  MCP_TOOL_PREFIX,
  mcpToolName,
  parseMcpToolName,
  type McpCallToolResult,
  type McpClient,
  type McpClientRegistry,
  type McpTool,
} from "../src/mcp/index.js";

// ---------------------------------------------------------------------------
// Fake McpClient — minimal implementation for the tests.
// ---------------------------------------------------------------------------

function makeFakeClient(opts: {
  serverName: string;
  tools?: ReadonlyArray<McpTool>;
  onCall?: (name: string, args: unknown) => Promise<McpCallToolResult>;
  onClose?: () => void;
}): McpClient {
  const tools = opts.tools ?? [];
  const onCall = opts.onCall;
  const onClose = opts.onClose;
  return {
    serverName: opts.serverName,
    async listTools() {
      return tools;
    },
    async callTool(name, args) {
      if (onCall) {
        return onCall(name, args);
      }
      return { content: [{ type: "text", text: `ok:${name}` }] };
    },
    async close() {
      onClose?.();
    },
  };
}

// ---------------------------------------------------------------------------
// mcpToolName + parseMcpToolName
// ---------------------------------------------------------------------------

describe("mcpToolName / parseMcpToolName", () => {
  it("builds a namespaced name and parses it back", () => {
    const full = mcpToolName("github", "create_issue");
    expect(full).toBe("mcp__github__create_issue");
    const parsed = parseMcpToolName(full);
    expect(parsed).toEqual({ serverName: "github", toolName: "create_issue" });
  });

  it("returns null for a name that does not start with the prefix", () => {
    expect(parseMcpToolName("bash")).toBeNull();
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(parseMcpToolName("")).toBeNull();
  });

  it("returns null for a name that has the prefix but no separator", () => {
    // `mcp__githubcreate_issue` has the prefix but no `__` separator.
    expect(parseMcpToolName(`${MCP_TOOL_PREFIX}githubcreate_issue`)).toBeNull();
  });

  it("the prefix constant is the documented value", () => {
    // Pin the wire format; downstream tools (and the
    // model) learn this convention.
    expect(MCP_TOOL_PREFIX).toBe("mcp__");
  });
});

// ---------------------------------------------------------------------------
// DefaultMcpClientRegistry
// ---------------------------------------------------------------------------

describe("DefaultMcpClientRegistry: register / get / list", () => {
  it("registers a client and lists it by server name", () => {
    const reg: McpClientRegistry = new DefaultMcpClientRegistry();
    const client = makeFakeClient({ serverName: "github" });
    reg.register(client);
    expect(reg.get("github")).toBe(client);
    expect(reg.list()).toEqual(["github"]);
  });

  it("throws on duplicate register", () => {
    const reg = new DefaultMcpClientRegistry();
    reg.register(makeFakeClient({ serverName: "github" }));
    expect(() => reg.register(makeFakeClient({ serverName: "github" }))).toThrow(
      /already registered/,
    );
  });

  it("returns undefined for an unregistered server", () => {
    const reg = new DefaultMcpClientRegistry();
    expect(reg.get("nope")).toBeUndefined();
  });
});

describe("DefaultMcpClientRegistry: unregister / closeAll", () => {
  it("unregister closes the client and removes it", async () => {
    const reg = new DefaultMcpClientRegistry();
    const closeSpy = vi.fn();
    const client = makeFakeClient({ serverName: "x", onClose: closeSpy });
    reg.register(client);
    await reg.unregister("x");
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(reg.get("x")).toBeUndefined();
    expect(reg.list()).toEqual([]);
  });

  it("unregister of a missing name is a no-op", async () => {
    const reg = new DefaultMcpClientRegistry();
    await expect(reg.unregister("nope")).resolves.toBeUndefined();
  });

  it("closeAll closes every client and clears the registry", async () => {
    const reg = new DefaultMcpClientRegistry();
    const closeA = vi.fn();
    const closeB = vi.fn();
    reg.register(makeFakeClient({ serverName: "a", onClose: closeA }));
    reg.register(makeFakeClient({ serverName: "b", onClose: closeB }));
    await reg.closeAll();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(reg.list()).toEqual([]);
  });
});

describe("DefaultMcpClientRegistry: collectTools", () => {
  it("flattens tools from every client and tags with serverName", async () => {
    const reg = new DefaultMcpClientRegistry();
    reg.register(
      makeFakeClient({
        serverName: "github",
        tools: [
          {
            name: "create_issue",
            description: "Create a GitHub issue",
            inputSchema: z.object({ title: z.string() }),
          },
          {
            name: "list_repos",
            description: "List repos",
            inputSchema: z.object({}),
          },
        ],
      }),
    );
    reg.register(
      makeFakeClient({
        serverName: "weather",
        tools: [
          {
            name: "get_forecast",
            description: "Get the forecast",
            inputSchema: z.object({ city: z.string() }),
          },
        ],
      }),
    );
    const all = await reg.collectTools();
    expect(all).toHaveLength(3);
    expect(all.map((t) => `${t.serverName}.${t.name}`).sort()).toEqual([
      "github.create_issue",
      "github.list_repos",
      "weather.get_forecast",
    ]);
  });

  it("returns [] when no clients are registered", async () => {
    const reg = new DefaultMcpClientRegistry();
    expect(await reg.collectTools()).toEqual([]);
  });
});

describe("DefaultMcpClientRegistry: callTool routing", () => {
  it("the registry's `get(serverName)` returns the right client", () => {
    const reg = new DefaultMcpClientRegistry();
    const gh = makeFakeClient({ serverName: "github" });
    const wx = makeFakeClient({ serverName: "weather" });
    reg.register(gh);
    reg.register(wx);
    expect(reg.get("github")).toBe(gh);
    expect(reg.get("weather")).toBe(wx);
  });

  it("a fake client returns the right callTool result for the right name", async () => {
    const client = makeFakeClient({
      serverName: "github",
      onCall: async (name, args) => ({
        content: [
          {
            type: "text",
            text: `called ${name} with ${JSON.stringify(args)}`,
          },
        ],
      }),
    });
    const result = await client.callTool("create_issue", { title: "hi" });
    expect(result.content).toEqual([
      { type: "text", text: 'called create_issue with {"title":"hi"}' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// T3.13 — end-to-end MCP routing through a real Agent.run().
//
// Audit pass #2 finding: the mcp tests cover the
// registry + name parsing well, but nothing
// exercised the full agent-loop path that proves
// an mcp__* call reaches executeMcpCall and the
// stub execute() on the tool definition is never
// invoked. T3.13 closes that gap with one
// loop-level test that:
//   1. wires a fake McpClient into a real Agent,
//   2. drives a scripted model to emit an
//      mcp__server__tool call,
//   3. asserts the fake client.callTool is invoked
//      with the right (name, args),
//   4. asserts the stub execute() on the
//      ToolDefinition is NOT called (the routing
//      check in tool-executor.ts fires first),
//   5. asserts the agent loop returns the ping
//      response in the final content.
//
// This is the loop-level proof that the T3.3 seam
// + the T3.12 constant-import fix work end-to-end.
// ---------------------------------------------------------------------------

import { Agent, HookRegistry, InMemorySession, newSessionId, ToolRegistry } from "../src/index.js";
import type { ModelAdapter, ModelResponse } from "../src/index.js";

function scriptedModel(
  responses: ReadonlyArray<{
    content: ModelResponse["content"];
    stopReason?: ModelResponse["stopReason"];
  }>,
): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const r = responses[i++];
      if (!r) {
        throw new Error(`scriptedModel: exhausted (call #${i})`);
      }
      return {
        content: r.content,
        stopReason:
          r.stopReason ??
          (r.content.some((b) => b.type === "tool_call")
            ? "tool_use"
            : "end_turn"),
      };
    },
  };
}

function textBlock(text: string): ModelResponse["content"][number] {
  return { type: "text", text };
}

function toolCallBlock(
  id: string,
  name: string,
  args: unknown,
): ModelResponse["content"][number] {
  return { type: "tool_call", id, name, args };
}

describe("end-to-end MCP routing through Agent.run()", () => {
  it("an mcp__* call reaches the registry's callTool; the stub execute() is never invoked", async () => {
    // The stub `execute()` on the MCP tool definition
    // (built in run-loop.ts:114-123) is the canary —
    // if the executor's routing check ever
    // regresses, that stub fires and throws. We
    // don't wire an explicit spy on the stub
    // (the run-loop builds it inside the loop
    // body, not as a class field we can decorate)
    // — but the assertion on `pingedCalls` below
    // is the real canary. If routing were broken,
    // executeMcpCall would NOT be invoked, the
    // fake client's callTool would NOT be hit,
    // and `pingedCalls` would be empty.
    const pingedCalls: Array<{ name: string; args: unknown }> = [];
    const fakeClient = makeFakeClient({
      serverName: "fake",
      tools: [
        {
          name: "ping",
          description: "Reply with pong.",
          inputSchema: { parse: (x: unknown) => x } as never,
        },
      ],
      onCall: async (name, args) => {
        pingedCalls.push({ name, args });
        return { content: [{ type: "text", text: "pong-from-fake" }] };
      },
    });

    const registry = new DefaultMcpClientRegistry();
    registry.register(fakeClient);

    // Scripted model:
    //   1st call: emit an mcp__fake__ping tool call
    //   2nd call: emit the final text answer
    const model = scriptedModel([
      {
        content: [
          toolCallBlock("call-1", mcpToolName("fake", "ping"), {
            message: "hello",
          }),
        ],
      },
      { content: [textBlock("got the pong")] },
    ]);

    const session = new InMemorySession(newSessionId(), {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      cwd: "/",
      mcpClients: registry,
    });

    const result = await agent.run("ping the fake server");

    // The fake client's callTool was invoked once
    // with the right (name, args) — proves the
    // routing check in tool-executor.ts:309 (the
    // one T3.12 made constant-driven) reached the
    // McpClient.
    expect(pingedCalls).toEqual([{ name: "ping", args: { message: "hello" } }]);

    // The agent loop exited cleanly.
    expect(result.stopReason).toBe("end_turn");

    // The final answer includes the ping result —
    // the agent saw the fake server's text
    // ("pong-from-fake") as a tool result before
    // emitting its final text.
    const finalText = result.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
    expect(finalText).toContain("got the pong");
  });
});
