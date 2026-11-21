/**
 * Wave 3 — MCP resources / prompts / elicitation seams + model tools.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../tools/types.js";
import type { McpClient, McpClientRegistry } from "./types.js";

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: ReadonlyArray<{ name: string; required?: boolean }>;
}

export interface McpResourceClient {
  listResources(): Promise<ReadonlyArray<McpResource>>;
  readResource(uri: string): Promise<{ uri: string; text?: string; mimeType?: string }>;
  listPrompts(): Promise<ReadonlyArray<McpPrompt>>;
  getPrompt?(
    name: string,
    args?: Record<string, string>,
  ): Promise<{ messages: unknown }>;
}

/** Optional elicitation handler (server→client ask). */
export type McpElicitationHandler = (req: {
  message: string;
  requestedSchema?: unknown;
}) => Promise<{ action: "accept" | "decline"; content?: unknown }>;

export function isMcpResourceClient(
  client: McpClient,
): client is McpClient & McpResourceClient {
  return (
    typeof (client as McpClient & Partial<McpResourceClient>).listResources ===
      "function" &&
    typeof (client as McpClient & Partial<McpResourceClient>).readResource ===
      "function"
  );
}

export function makeMcpResourceTools(registry: McpClientRegistry): Tool[] {
  const listResources: Tool = {
    name: "list_mcp_resources",
    description: "List MCP resources from connected servers.",
    parameters: z.object({
      server: z.string().optional().describe("Optional server name filter."),
    }),
    isConcurrencySafe: () => true,
    async execute(args): Promise<ToolResult> {
      const names =
        args.server !== undefined ? [args.server] : [...registry.list()];
      const out: Array<McpResource & { server: string }> = [];
      for (const name of names) {
        const client = registry.get(name);
        if (client === undefined || !isMcpResourceClient(client)) continue;
        const resources = await client.listResources();
        for (const r of resources) out.push({ ...r, server: name });
      }
      return { content: JSON.stringify({ ok: true, resources: out }) };
    },
  };

  const readResource: Tool = {
    name: "read_mcp_resource",
    description: "Read one MCP resource by server + uri.",
    parameters: z.object({
      server: z.string().min(1),
      uri: z.string().min(1),
    }),
    isConcurrencySafe: () => true,
    async execute(args): Promise<ToolResult> {
      const client = registry.get(args.server);
      if (client === undefined || !isMcpResourceClient(client)) {
        return {
          content: `MCP server '${args.server}' has no resources API`,
          isError: true,
        };
      }
      const body = await client.readResource(args.uri);
      return { content: JSON.stringify({ ok: true, ...body }) };
    },
  };

  const listPrompts: Tool = {
    name: "list_mcp_prompts",
    description: "List MCP prompts from connected servers.",
    parameters: z.object({
      server: z.string().optional(),
    }),
    isConcurrencySafe: () => true,
    async execute(args): Promise<ToolResult> {
      const names =
        args.server !== undefined ? [args.server] : [...registry.list()];
      const out: Array<McpPrompt & { server: string }> = [];
      for (const name of names) {
        const client = registry.get(name);
        if (client === undefined || !isMcpResourceClient(client)) continue;
        if (typeof client.listPrompts !== "function") continue;
        const prompts = await client.listPrompts();
        for (const p of prompts) out.push({ ...p, server: name });
      }
      return { content: JSON.stringify({ ok: true, prompts: out }) };
    },
  };

  return [listResources, readResource, listPrompts];
}
