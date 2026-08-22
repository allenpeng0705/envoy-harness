/**
 * Phase G — MCP tool bridge: MCP servers' tools become envoy tools
 * (`mcp__<server>__<tool>`) and route back to the right client.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DefaultMcpClientRegistry,
  formatMcpResult,
  registerMcpTools,
  type McpClient,
} from "../src/mcp/index.js";
import { ToolRegistry } from "../src/tools/index.js";

function fakeClient(
  serverName: string,
  tools: Array<{
    name: string;
    description: string;
    result: unknown;
    throws?: boolean;
  }>,
): McpClient {
  return {
    serverName,
    async listTools() {
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.object({}),
      }));
    },
    async callTool(name, _args) {
      const tool = tools.find((t) => t.name === name);
      if (tool?.throws) throw new Error(`boom on ${name}`);
      return { content: [{ type: "text", text: String(tool?.result ?? "ok") }] };
    },
    async close() {},
  };
}

describe("registerMcpTools", () => {
  it("registers namespaced tools and routes calls to the right client", async () => {
    const registry = new DefaultMcpClientRegistry();
    registry.register(
      fakeClient("github", [
        { name: "create_issue", description: "Create an issue", result: "created" },
      ]),
    );
    registry.register(
      fakeClient("web", [{ name: "search", description: "Search", result: "hits" }]),
    );

    const tools = new ToolRegistry();
    const result = await registerMcpTools(tools, registry);
    expect(result.registered).toBe(2);
    expect(result.catalog).toContain("mcp__github__create_issue");
    expect(result.catalog).toContain("mcp__web__search");

    const githubTool = tools.get("mcp__github__create_issue");
    expect(githubTool).toBeDefined();
    expect(githubTool?.description).toBe("Create an issue");

    const out = await githubTool!.execute({}, { cwd: "/tmp", session: { id: "s" } as never, abortSignal: new AbortController().signal });
    expect(out.content).toBe("created");

    const webTool = tools.get("mcp__web__search");
    const webOut = await webTool!.execute({}, { cwd: "/tmp", session: { id: "s" } as never, abortSignal: new AbortController().signal });
    expect(webOut.content).toBe("hits");
  });

  it("maps client errors to isError results", async () => {
    const registry = new DefaultMcpClientRegistry();
    registry.register(
      fakeClient("github", [
        { name: "broken", description: "B", result: "", throws: true },
      ]),
    );
    const tools = new ToolRegistry();
    await registerMcpTools(tools, registry);
    const out = await tools
      .get("mcp__github__broken")!
      .execute({}, { cwd: "/tmp", session: { id: "s" } as never, abortSignal: new AbortController().signal });
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain("boom on broken");
  });

  it("isolates a failing server and still registers the others", async () => {
    const registry = new DefaultMcpClientRegistry();
    registry.register({
      serverName: "down",
      async listTools() {
        throw new Error("server unreachable");
      },
      async callTool() {
        return { content: [] };
      },
      async close() {},
    });
    registry.register(
      fakeClient("web", [{ name: "search", description: "Search", result: "hits" }]),
    );
    const tools = new ToolRegistry();
    const result = await registerMcpTools(tools, registry);
    expect(result.registered).toBe(1);
    expect(result.errors).toEqual([
      { server: "down", error: "server unreachable" },
    ]);
    expect(tools.get("mcp__web__search")).toBeDefined();
  });
});

describe("formatMcpResult", () => {
  it("renders text blocks and summarizes images", () => {
    const text = formatMcpResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
    });
    expect(text).toContain("hello");
    expect(text).toContain("[image image/png");
  });
});
