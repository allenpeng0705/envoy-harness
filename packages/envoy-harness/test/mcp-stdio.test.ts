/**
 * T3.3.1 — `StdioMcpClient` tests over a scripted stdio pair.
 *
 * Covers: the `initialize` handshake, `tools/list` (JSON Schema
 * → zod conversion), `tools/call`, request timeouts, and close.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  jsonSchemaToZod,
  MCP_PROTOCOL_VERSION,
  StdioMcpClient,
  type McpStdioProcess,
} from "../src/mcp/index.js";

function frame(body: unknown): string {
  const s = JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(s, "utf8")}\r\n\r\n${s}`;
}

type Listener = (chunk: Buffer | string) => void;

/** A scripted server: records client writes, lets tests push responses. */
function fakeProcess(): McpStdioProcess & {
  writesToServer: string[];
  feed: (chunk: string) => void;
  killCalls: () => number;
} {
  const listeners: Array<(chunk: Buffer | string) => void> = [];
  const writes: string[] = [];
  let killed = 0;
  return {
    writesToServer: writes,
    stdin: {
      write(chunk: string): void {
        writes.push(chunk);
      },
      end(): void {},
    },
    stdout: {
      on(_evt: string, listener: Listener): void {
        listeners.push(listener);
      },
      off(_evt: string, listener: Listener): void {
        const i = listeners.indexOf(listener);
        if (i !== -1) listeners.splice(i, 1);
      },
    },
    kill(): void {
      killed++;
    },
    feed(chunk: string): void {
      for (const l of listeners) l(chunk);
    },
    killCalls(): number {
      return killed;
    },
  };
}

function parseClientMessages(fake: ReturnType<typeof fakeProcess>): unknown[] {
  const out: unknown[] = [];
  for (const w of fake.writesToServer) {
    const headerEnd = w.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const m = /^Content-Length:\s*(\d+)\s*$/im.exec(w.slice(0, headerEnd));
    if (!m) continue;
    const len = Number(m[1]);
    out.push(JSON.parse(w.slice(headerEnd + 4, headerEnd + 4 + len)));
  }
  return out;
}

describe("StdioMcpClient", () => {
  it("runs the initialize handshake and lists tools (JSON Schema → zod)", async () => {
    const fake = fakeProcess();
    const client = new StdioMcpClient({
      serverName: "github",
      process: fake,
    });
    const p = client.connect();
    // Respond to initialize; the notifications/initialized
    // notification needs no response.
    fake.feed(frame({ jsonrpc: "2.0", id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION } }));
    await p;
    const msgs = parseClientMessages(fake);
    expect((msgs[0] as { method?: string }).method).toBe("initialize");
    expect((msgs[1] as { method?: string }).method).toBe("notifications/initialized");

    const toolsP = client.listTools();
    const msgs3 = parseClientMessages(fake);
    const listReq = msgs3[msgs3.length - 1] as { method?: string; id?: number };
    fake.feed(
      frame({
        jsonrpc: "2.0",
        id: listReq?.id,
        result: {
          tools: [
            {
              name: "create_issue",
              description: "Create an issue",
              inputSchema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  labels: { type: "array", items: { type: "string" } },
                  urgent: { type: "boolean" },
                },
                required: ["title"],
              },
            },
          ],
        },
      }),
    );
    const tools = await toolsP;
    expect(tools).toHaveLength(1);
    const schema = tools[0]!.inputSchema;
    const parsed = schema.safeParse({ title: "x" });
    expect(parsed.success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // title required
    await client.close();
  });

  it("calls a tool and returns the content", async () => {
    const fake = fakeProcess();
    const client = new StdioMcpClient({ serverName: "s", process: fake });
    client.connect().catch(() => {});
    fake.feed(frame({ jsonrpc: "2.0", id: 1, result: {} }));
    await new Promise((r) => setImmediate(r));
    const callP = client.callTool("echo", { text: "hi" });
    const msgs = parseClientMessages(fake);
    const callReq = msgs[msgs.length - 1] as { method?: string; params?: { name?: string }; id?: number };
    expect(callReq?.method).toBe("tools/call");
    expect(callReq?.params?.name).toBe("echo");
    fake.feed(
      frame({
        jsonrpc: "2.0",
        id: callReq?.id,
        result: { content: [{ type: "text", text: "ok" }] },
      }),
    );
    const result = await callP;
    expect(result.content[0]).toEqual({ type: "text", text: "ok" });
    await client.close();
  });

  it("times out a request the server never answers", async () => {
    const fake = fakeProcess();
    const client = new StdioMcpClient({
      serverName: "s",
      process: fake,
      requestTimeoutMs: 20,
    });
    client.connect().catch(() => {});
    fake.feed(frame({ jsonrpc: "2.0", id: 1, result: {} }));
    await new Promise((r) => setImmediate(r));
    await expect(client.callTool("echo", {})).rejects.toThrow(/timed out/);
  });

  it("warns (not fails) when the server negotiates a different protocolVersion", async () => {
    const fake = fakeProcess();
    const logs: string[] = [];
    const client = new StdioMcpClient({
      serverName: "s",
      process: fake,
      log: (msg) => logs.push(msg),
    });
    const p = client.connect();
    fake.feed(frame({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }));
    await p;
    expect(logs.some((l) => l.includes("negotiated 2025-06-18"))).toBe(true);
    await client.close();
  });
});

describe("jsonSchemaToZod", () => {
  it("handles object/string/number/boolean/array/enum + required", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        s: { type: "string" },
        n: { type: "number" },
        b: { type: "boolean" },
        a: { type: "array", items: { type: "string" } },
        e: { type: "string", enum: ["x", "y"] },
      },
      required: ["s"],
    });
    const type = schema as unknown as z.ZodObject<Record<string, z.ZodTypeAny>>;
    expect(type.shape.s).toBeInstanceOf(z.ZodString);
    // `e` is optional (not in `required`) → wrapped in ZodOptional.
    expect(type.shape.e).toBeInstanceOf(z.ZodOptional);
    expect((type.shape.e as z.ZodOptional<z.ZodEnum<[string, ...string[]]>>).unwrap()).toBeInstanceOf(z.ZodEnum);
    expect(schema.safeParse({ s: "ok" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("falls back to unknown for exotic shapes", () => {
    const schema = jsonSchemaToZod({ anyOf: [{ type: "string" }] });
    expect(schema).toBeInstanceOf(z.ZodUnknown);
  });
});
