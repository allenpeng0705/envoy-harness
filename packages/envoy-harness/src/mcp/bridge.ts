/**
 * Phase G — MCP tool bridge: connect MCP servers to envoy's model-facing
 * tools.
 *
 * Every tool from every registered MCP client becomes an envoy `Tool`
 * named `mcp__<server>__<rawName>` (the same server-qualified convention
 * Codex, Claude Code, and deepseek's `dsh-mcp-client` use), so the whole
 * MCP ecosystem — not just one harness — is reusable through envoy's
 * existing tool registry, hooks, permissions, and sandbox.
 *
 * `registerMcpTools` is additive: it registers the bridge tools and
 * returns `{ registered, catalog }` for the host's bookkeeping / prompt
 * catalog. Call it after the registry is populated (or re-call to
 * re-sync after a server's tool list changes).
 */

import type {
  MultimodalToolContent,
  ToolImageContent,
} from "../tools/multimodal.js";
import {
  multimodalToolContentToText,
} from "../tools/multimodal.js";
import type { Tool, ToolResult } from "../tools/types.js";
import {
  mcpToolName,
  type McpCallToolResult,
  type McpClientRegistry,
} from "./types.js";

export interface McpToolBridgeResult {
  /** Number of MCP tools registered as envoy tools. */
  registered: number;
  /** Sorted `mcp__<server>__<tool>` names (one per line) for catalogs. */
  catalog: string;
  /** Servers whose tool list could not be read (others still registered). */
  errors: ReadonlyArray<{ server: string; error: string }>;
}

/**
 * Convert an MCP `tools/call` result into multimodal tool content so
 * image blocks reach the model as vision input (not text placeholders).
 */
export function mcpResultToMultimodal(
  result: McpCallToolResult,
): MultimodalToolContent {
  const textParts: string[] = [];
  const images: ToolImageContent[] = [];
  for (const block of result.content) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);
        break;
      case "image":
        images.push({ mimeType: block.mimeType, data: block.data });
        break;
      case "resource":
        textParts.push(block.text ?? `[resource ${block.uri}]`);
        break;
    }
  }
  return { text: textParts.join("\n"), images };
}

/** Text-only rendering (legacy / hosts without vision). */
export function formatMcpResult(result: McpCallToolResult): string {
  return multimodalToolContentToText(mcpResultToMultimodal(result));
}

/**
 * Register every MCP tool from every registered client into an envoy
 * tool registry. Duplicate server names (or duplicate tool names within a
 * server) throw via the registry's own duplicate checks.
 */
export async function registerMcpTools(
  tools: { register(tool: Tool): unknown },
  registry: McpClientRegistry,
): Promise<McpToolBridgeResult> {
  let registered = 0;
  const catalog: string[] = [];
  const errors: Array<{ server: string; error: string }> = [];
  for (const serverName of registry.list()) {
    const client = registry.get(serverName);
    if (client === undefined) continue;
    let mcpTools;
    try {
      mcpTools = await client.listTools();
    } catch (err) {
      // Per-server isolation: a down/unresponsive server must not
      // prevent the other servers' tools from registering.
      errors.push({
        server: serverName,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const tool of mcpTools) {
      const fullName = mcpToolName(serverName, tool.name);
      tools.register({
        name: fullName,
        description: tool.description,
        parameters: tool.inputSchema,
        async execute(args): Promise<ToolResult> {
          try {
            const result = await client.callTool(tool.name, args);
            return { content: mcpResultToMultimodal(result) };
          } catch (err) {
            return {
              content: `mcp error (${fullName}): ${
                err instanceof Error ? err.message : String(err)
              }`,
              isError: true,
            };
          }
        },
      });
      registered++;
      catalog.push(fullName);
    }
  }
  return { registered, catalog: catalog.sort().join("\n"), errors };
}
