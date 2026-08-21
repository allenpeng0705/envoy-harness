/**
 * MCP stdio transport (T3.3.1) — `StdioMcpClient`.
 *
 * **What this is:** the concrete `McpClient` implementation
 * that talks to a real MCP server over stdio (JSON-RPC 2.0 +
 * `Content-Length` framing — the same framing the LSP client
 * uses). The host spawns the server (e.g.
 * `npx -y @modelcontextprotocol/server-github`) and hands the
 * streams in.
 *
 * **Protocol surface:**
 * - `initialize` handshake (protocolVersion + capabilities)
 * - `tools/list` → `McpTool[]` (JSON Schema converted to zod
 *   via `jsonSchemaToZod`)
 * - `tools/call` → `McpCallToolResult`
 * - `close` → `shutdown` + `exit` + kill
 *
 * **Request timeout:** each request/response round-trip has a
 * timeout (default 10s) so a hung server can't block the agent
 * turn forever.
 *
 * **Why JSON Schema → zod:** the `Tool` interface used for the
 * model's tool list requires a zod `parameters` schema. The MCP
 * server sends JSON Schema; `jsonSchemaToZod` converts the
 * common shapes (object/string/number/boolean/array/enum) and
 * falls back to `z.unknown()` for anything else.
 */

import { z } from "zod";

import type {
  McpCallToolResult,
  McpClient,
  McpTool,
} from "./types.js";

/** The minimum child-process surface `StdioMcpClient` needs. */
export interface McpStdioProcess {
  stdin: { write(chunk: string): void; end(): void };
  stdout: {
    on(
      event: "data",
      listener: (chunk: Buffer | string) => void,
    ): unknown;
    off(
      event: "data",
      listener: (chunk: Buffer | string) => void,
    ): unknown;
  };
  kill(signal?: string): void;
}

/** Options for `StdioMcpClient`. */
export interface StdioMcpClientOptions {
  /** The server's display name (the registry key). */
  serverName: string;
  /** The child process streams. */
  process: McpStdioProcess;
  /** Request timeout in ms. Default 10_000. */
  requestTimeoutMs?: number;
  /** Optional wire logger. */
  log?: (msg: string) => void;
}

/** The MCP protocol version we advertise. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpServerTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * A `McpClient` that speaks JSON-RPC 2.0 over stdio.
 * The connection owns the child process; `close()` releases it.
 */
export class StdioMcpClient implements McpClient {
  readonly serverName: string;
  private readonly process: McpStdioProcess;
  private readonly requestTimeoutMs: number;
  private readonly log: (msg: string) => void;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private buffer = Buffer.alloc(0);
  private _initialized = false;
  private _closed = false;
  private readonly dataListener: (chunk: Buffer | string) => void;

  constructor(options: StdioMcpClientOptions) {
    this.serverName = options.serverName;
    this.process = options.process;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.log = options.log ?? (() => {});
    this.dataListener = (chunk) => this.onData(chunk);
    this.process.stdout.on("data", this.dataListener);
  }

  /** Run the `initialize` handshake. Must be called once. */
  async connect(): Promise<void> {
    this.assertOpen();
    const result = (await this.sendRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "envoy-harness", version: "0.0.0" },
    })) as { protocolVersion?: string } | undefined;
    // Best-effort version negotiation: the spec requires the
    // server to echo the negotiated version, but a missing or
    // different version is not fatal in practice (most servers
    // speak 2024-11-05). Warn instead of failing — the tools
    // either work or the calls error naturally.
    if (result?.protocolVersion === undefined) {
      this.log(
        `StdioMcpClient: server "${this.serverName}" did not return a protocolVersion`,
      );
    } else if (result.protocolVersion !== MCP_PROTOCOL_VERSION) {
      this.log(
        `StdioMcpClient: server "${this.serverName}" negotiated ` +
          `${result.protocolVersion} (client sent ${MCP_PROTOCOL_VERSION}); ` +
          "continuing best-effort",
      );
    }
    this.sendNotification("notifications/initialized", {});
    this._initialized = true;
  }

  async listTools(): Promise<ReadonlyArray<McpTool>> {
    this.assertInitialized();
    const result = (await this.sendRequest("tools/list", {})) as {
      tools?: McpServerTool[];
    };
    return (result?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: jsonSchemaToZod(t.inputSchema ?? {}),
    }));
  }

  async callTool(
    name: string,
    args: unknown,
  ): Promise<McpCallToolResult> {
    this.assertInitialized();
    const result = (await this.sendRequest("tools/call", {
      name,
      arguments: args,
    })) as {
      content?: McpCallToolResult["content"];
      isError?: boolean;
    };
    return {
      content: result?.content ?? [],
      ...(result?.isError !== undefined ? { isError: result.isError } : {}),
    };
  }

  async close(): Promise<void> {
    if (this._closed) return;
    try {
      if (this._initialized) {
        try {
          // Best-effort with a short timeout: a server that
          // never answers shutdown shouldn't block close().
          await this.sendRequest("shutdown", {}, 1000);
        } catch {
          // Best-effort; the server may already be dead.
        }
      }
      this.process.stdin.end();
    } finally {
      this.process.stdout.off("data", this.dataListener);
      for (const { reject } of this.pending.values()) {
        reject(new Error("StdioMcpClient: closed"));
      }
      this.pending.clear();
      this.process.kill();
      this._closed = true;
    }
  }

  // --- internals ---

  private assertOpen(): void {
    if (this._closed) throw new Error("StdioMcpClient: closed");
  }

  private assertInitialized(): void {
    this.assertOpen();
    if (!this._initialized) {
      throw new Error("StdioMcpClient: call connect() first");
    }
  }

  private sendRequest(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    this.assertOpen();
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    this.process.stdin.write(
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
    );
    return new Promise<unknown>((resolve, reject) => {
      const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.reject(
          new Error(`StdioMcpClient: request timed out after ${effectiveTimeout}ms: ${method}`),
        );
      }, effectiveTimeout);
      this.pending.set(id, {
        resolve,
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /** Write a JSON-RPC notification (no id, no response expected). */
  private sendNotification(method: string, params: unknown): void {
    this.assertOpen();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    this.process.stdin.write(
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
    );
  }

  private onData(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.buffer = Buffer.concat([this.buffer, buf]);
    this.drain();
  }

  private drain(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const m = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
      if (!m) {
        this.log(`StdioMcpClient: bad header: ${header.slice(0, 80)}`);
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const total = headerEnd + 4 + len;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(headerEnd + 4, total).toString("utf8");
      this.buffer = this.buffer.subarray(total);
      try {
        this.handleMessage(JSON.parse(body) as JsonRpcResponse);
      } catch (e) {
        this.log(`StdioMcpClient: parse error: ${(e as Error).message}`);
      }
    }
  }

  private handleMessage(msg: JsonRpcResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) {
      this.log(`StdioMcpClient: response for unknown id ${msg.id}`);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(
        new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
      );
    } else {
      pending.resolve(msg.result);
    }
  }
}

/**
 * Convert a JSON Schema (from `tools/list`) into a zod schema
 * for the model's tool definitions. Handles the common MCP
 * shapes; anything unrecognized falls back to `z.unknown()` so
 * the tool list never breaks on an exotic schema.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const type = schema["type"];
  if (type === "object" || schema["properties"] !== undefined) {
    const properties = (schema["properties"] ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const required = new Set(
      Array.isArray(schema["required"]) ? schema["required"] : [],
    );
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      const prop = jsonSchemaToZod(propSchema);
      shape[key] = required.has(key) ? prop : prop.optional();
    }
    return z.object(shape);
  }
  if (type === "string") {
    if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) {
      const values = schema["enum"] as string[];
      if (values.every((v) => typeof v === "string")) {
        return z.enum(values as [string, ...string[]]);
      }
    }
    return z.string();
  }
  if (type === "number" || type === "integer") return z.number();
  if (type === "boolean") return z.boolean();
  if (type === "array") {
    const items = schema["items"] as Record<string, unknown> | undefined;
    return z.array(items ? jsonSchemaToZod(items) : z.unknown());
  }
  return z.unknown();
}
