/**
 * MCP stdio server — hermetic scripted stdin/stdout.
 */

import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { encodeFrame, FrameDecoder } from "../src/protocol/framing.js";
import { runStdioMcpServer } from "../src/mcp/stdio-server.js";
import { ToolRegistry } from "../src/tools/registry.js";

function readFrame(decoder: FrameDecoder) {
  return decoder.take()[0] as Record<string, unknown>;
}

describe("runStdioMcpServer", () => {
  it("initialize, tools/list, and tools/call over Content-Length framing", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo a message",
      parameters: z.object({ msg: z.string() }),
      execute: async (args) => ({ content: args.msg }),
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const decoder = new FrameDecoder();

    output.on("data", (chunk: Buffer) => {
      decoder.feed(chunk);
    });

    const server = runStdioMcpServer({
      tools,
      toolContext: { cwd: "/tmp" },
      input,
      output,
    });

    input.write(
      encodeFrame({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    const initRes = readFrame(decoder);
    expect(initRes["result"]).toMatchObject({
      protocolVersion: "2024-11-05",
    });

    input.write(
      encodeFrame({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    const listRes = readFrame(decoder) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(listRes.result?.tools?.map((t) => t.name)).toContain("echo");

    input.write(
      encodeFrame({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { msg: "hello" } },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    const callRes = readFrame(decoder) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(callRes.result?.content?.[0]?.text).toBe("hello");

    input.end();
    await server;
  });
});
