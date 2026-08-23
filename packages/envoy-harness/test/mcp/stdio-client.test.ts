/**
 * StdioMcpClient — MCP progress notification forwarding.
 */

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  MCP_PROTOCOL_VERSION,
  StdioMcpClient,
  type McpStdioProcess,
} from "../../src/mcp/stdio-client.js";

function frameJson(obj: unknown): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function parseLastRequest(writes: string[]): {
  id?: number;
  method?: string;
  params?: unknown;
} {
  const last = writes[writes.length - 1] ?? "";
  const idx = last.indexOf("\r\n\r\n");
  const body = idx >= 0 ? last.slice(idx + 4) : last;
  return JSON.parse(body) as {
    id?: number;
    method?: string;
    params?: unknown;
  };
}

function makeMockProcess(): McpStdioProcess & {
  stdout: EventEmitter;
  stdin: { writes: string[]; write(chunk: string): void; end(): void };
} {
  const stdout = new EventEmitter();
  const stdin = {
    writes: [] as string[],
    write(chunk: string) {
      stdin.writes.push(chunk);
      const req = parseLastRequest(stdin.writes);
      queueMicrotask(() => {
        if (req.method === "initialize") {
          stdout.emit(
            "data",
            frameJson({
              jsonrpc: "2.0",
              id: req.id,
              result: { protocolVersion: MCP_PROTOCOL_VERSION },
            }),
          );
        } else if (req.method === "tools/call") {
          stdout.emit(
            "data",
            frameJson({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { message: "halfway" },
            }),
          );
          stdout.emit(
            "data",
            frameJson({
              jsonrpc: "2.0",
              id: req.id,
              result: { content: [{ type: "text", text: "done" }] },
            }),
          );
        }
      });
    },
    end() {},
  };
  return {
    stdin,
    stdout,
    kill() {},
  };
}

describe("StdioMcpClient progress", () => {
  it("forwards notifications/progress during callTool", async () => {
    const process = makeMockProcess();
    const client = new StdioMcpClient({
      serverName: "test",
      process,
    });
    await client.connect();

    const progress: string[] = [];
    const result = await client.callTool("ping", { x: 1 }, {
      onProgress: (text) => progress.push(text),
    });

    expect(progress).toEqual(["halfway"]);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    await client.close();
  });
});
