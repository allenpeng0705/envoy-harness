/**
 * MCP stdio server — expose envoy-harness tools to external MCP clients.
 *
 * Speaks JSON-RPC 2.0 + Content-Length framing (same as `StdioMcpClient`).
 * Implements `initialize`, `tools/list`, and `tools/call` against a
 * {@link ToolRegistry}.
 */

import type { Readable, Writable } from "node:stream";

import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { zodToJsonSchema } from "../llm/http.js";
import { encodeFrame, FrameDecoder } from "../protocol/framing.js";
import type { JsonRpcMessage } from "../protocol/types.js";

export const MCP_SERVER_PROTOCOL_VERSION = "2024-11-05";

export interface StdioMcpServerOptions {
  tools: ToolRegistry;
  /** Tool execution context (cwd + abort). */
  toolContext: Omit<ToolContext, "session"> & { session?: ToolContext["session"] };
  input?: Readable;
  output?: Writable;
  serverInfo?: { name: string; version: string };
}

/** Run the MCP server until the input stream ends. */
export async function runStdioMcpServer(
  options: StdioMcpServerOptions,
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const serverInfo = options.serverInfo ?? {
    name: "envoy-harness",
    version: "0.0.0",
  };
  const decoder = new FrameDecoder();
  let nextId = 1;
  let initialized = false;

  const write = (msg: JsonRpcMessage): void => {
    output.write(encodeFrame(msg));
  };

  const handleRequest = async (
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> => {
    try {
      switch (method) {
        case "initialize":
          initialized = true;
          write({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_SERVER_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo,
            },
          });
          return;
        case "notifications/initialized":
          return;
        case "tools/list": {
          if (!initialized) throw new Error("not initialized");
          const tools = options.tools.list().map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: zodToJsonSchema(t.parameters),
          }));
          write({ jsonrpc: "2.0", id, result: { tools } });
          return;
        }
        case "tools/call": {
          if (!initialized) throw new Error("not initialized");
          const p = params as { name?: string; arguments?: unknown };
          if (typeof p.name !== "string") {
            throw new Error("name required");
          }
          const tool = options.tools.get(p.name);
          if (tool === undefined) {
            throw new Error(`unknown tool: ${p.name}`);
          }
          const parsed = tool.parameters.safeParse(p.arguments ?? {});
          if (!parsed.success) {
            throw new Error(parsed.error.message);
          }
          const abort = new AbortController();
          const ctx: ToolContext = {
            cwd: options.toolContext.cwd,
            session: options.toolContext.session as ToolContext["session"],
            abortSignal: abort.signal,
            ...(options.toolContext.sandboxPolicy !== undefined
              ? { sandboxPolicy: options.toolContext.sandboxPolicy }
              : {}),
            ...(options.toolContext.recordUndo !== undefined
              ? { recordUndo: options.toolContext.recordUndo }
              : {}),
          };
          const result = await tool.execute(parsed.data, ctx);
          const text =
            typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content, null, 2);
          write({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text }],
              isError: result.isError === true,
            },
          });
          return;
        }
        default:
          write({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `method not found: ${method}` },
          });
      }
    } catch (err) {
      write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  await new Promise<void>((resolve) => {
    input.on("data", (chunk: Buffer | string) => {
      decoder.feed(chunk);
      for (const msg of decoder.take()) {
        if ("method" in msg && msg.method !== undefined) {
          const reqId = "id" in msg && msg.id !== undefined ? msg.id : nextId++;
          void handleRequest(reqId, msg.method, msg.params);
        }
      }
    });
    input.on("end", () => resolve());
    input.on("close", () => resolve());
  });
}
