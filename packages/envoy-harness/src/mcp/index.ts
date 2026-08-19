/**
 * MCP (Model Context Protocol) — public API.
 *
 * **T3.3 scope:** the type seam + a default
 * registry. The actual transport (stdio JSON-RPC
 * child process) lands in a follow-up sub-chunk.
 *
 * Re-exports the types, the helpers, and the
 * default registry.
 */
export {
  MCP_TOOL_PREFIX,
  mcpToolName,
  parseMcpToolName,
  type McpClient,
  type McpClientRegistry,
  type McpCallToolResult,
  type McpTool,
} from "./types.js";
export { DefaultMcpClientRegistry } from "./registry.js";
