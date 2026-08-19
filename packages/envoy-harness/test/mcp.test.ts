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
  McpClient,
  McpClientRegistry,
  McpCallToolResult,
  McpTool,
  mcpToolName,
  parseMcpToolName,
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
