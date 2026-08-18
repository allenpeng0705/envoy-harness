/**
 * StdioLspClient — an `LspClient` that talks to a real
 * language server over stdio.
 *
 * **What this is:** the production `LspClient`. Speaks the
 * LSP protocol (JSON-RPC 2.0 over stdio with `Content-Length`
 * framing) against a child process. The host spawns the
 * server (e.g. `typescript-language-server --stdio`) and
 * hands the streams to this class.
 *
 * **Why take the streams as inputs:** the host owns the
 * process lifecycle. Spawning is F9.2+1 (auto-spawn by
 * extension). For v0, the host does:
 *
 * ```ts
 * const child = spawn("typescript-language-server", ["--stdio"]);
 * const client = new StdioLspClient({
 *   stdin: child.stdin,
 *   stdout: child.stdout,
 *   process: child,
 * });
 * await client.initialize({ rootUri: "file:///..." });
 * ```
 *
 * **JSON-RPC 2.0 + LSP framing:** each message is preceded
 * by a header section:
 *
 * ```
 * Content-Length: 123\r\n
 * \r\n
 * {"jsonrpc":"2.0","id":1,...}
 * ```
 *
 * The body length must match the `Content-Length` value.
 * We don't send `Content-Type` (LSP servers don't require
 * it; some ignore it).
 *
 * **Concurrency:** multiple requests can be in flight at
 * once. Each request gets a unique `id`; responses are
 * matched by `id`. We use a `Map<id, {resolve, reject}>`
 * for outstanding requests.
 *
 * **Server-initiated requests:** LSP servers can send
 * requests (not just notifications) that need a reply
 * (e.g. `client/registerCapability`,
 * `window/workDoneProgress/create`). For v0, we accept
 * them and reply with `null` (the LSP spec's "method not
 * supported" pattern). A future chunk can add a
 * `registerHandler(method, fn)` API.
 *
 * **Server-initiated notifications:** e.g.
 * `textDocument/publishDiagnostics` (the server pushes
 * diagnostics to us; we don't ask). We track them in a
 * `Map<file, LspDiagnostic[]>`; `diagnostics(file)` reads
 * the current map.
 *
 * **`initialize` / `initialized` handshake:** the LSP
 * spec REQUIRES:
 * 1. Client sends `initialize` request.
 * 2. Server replies with its capabilities.
 * 3. Client sends `initialized` notification.
 *
 * We do this in the constructor's `initialize()` method
 * (called explicitly by the host). Until `initialize()`
 * resolves, the 4 ops throw.
 *
 * **Stability:** the public surface is `StdioLspClient`
 * (class) + `StdioLspClientOptions` (interface) +
 * `LspProcess` (interface). Additive.
 */

import type {
  LspClient,
  LspDiagnostic,
  LspHover,
  LspLocation,
} from "./types.js";

// ---------------------------------------------------------------------------
// Stdio abstraction
// ---------------------------------------------------------------------------

/**
 * The minimum stdio surface a child process must expose
 * for `StdioLspClient` to talk to it.
 *
 * The host can pass `child.stdin` / `child.stdout` directly
 * (both implement `Writable` / `Readable`). For tests, a
 * `FakeStdio` pair implements this interface and lets the
 * test script the server's responses.
 */
export interface LspProcess {
  /** Writable stream to the server's stdin. */
  stdin: { write(chunk: string): void; end(): void };
  /**
   * Readable stream from the server's stdout. The client
   * attaches a `data` listener; the host MUST NOT attach
   * one first (Node's EventEmitter would shadow the
   * listener).
   */
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
  /** Called by `close()` to terminate the child. */
  kill(signal?: string): void;
}

/** Options for `StdioLspClient`. */
export interface StdioLspClientOptions {
  /** The server process to talk to. */
  process: LspProcess;
  /**
   * The root URI of the workspace (e.g. `file:///home/user/proj`).
   * Sent in the `initialize` request.
   */
  rootUri: string;
  /**
   * Client capabilities (advertised in `initialize`). The
   * default advertises "we can receive diagnostics via
   * publishDiagnostics" and nothing else.
   */
  clientCapabilities?: Record<string, unknown>;
  /**
   * Optional logger for wire-level events (init, errors,
   * unexpected server messages). Off by default.
   */
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcServerRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcServerRequest;

// ---------------------------------------------------------------------------
// StdioLspClient
// ---------------------------------------------------------------------------

/**
 * The production `LspClient`. Talks JSON-RPC 2.0 over stdio
 * to a child process. See module doc for the full protocol
 * summary.
 */
export class StdioLspClient implements LspClient {
  private readonly process: LspProcess;
  private readonly rootUri: string;
  private readonly clientCapabilities: Record<string, unknown>;
  private readonly log: (msg: string) => void;

  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly diagnosticsMap = new Map<string, LspDiagnostic[]>();
  private _initialized = false;
  /**
   * Set to `true` by `close()` once the shutdown/exit
   * dance is complete and the process is killed. New
   * requests throw via `assertOpen`. During the
   * shutdown/exit dance itself, `_closing` is true but
   * `_closed` is still false, so the in-flight
   * `sendRequest` / `sendNotification` calls don't hit
   * the `assertOpen` guard.
   */
  private _closing = false;
  private _closed = false;
  private readonly dataListener: (chunk: Buffer | string) => void;
  private buffer = Buffer.alloc(0);

  constructor(options: StdioLspClientOptions) {
    this.process = options.process;
    this.rootUri = options.rootUri;
    this.clientCapabilities = options.clientCapabilities ?? {
      // The default capability set: we accept diagnostics
      // (via publishDiagnostics) and that's it. v0 doesn't
      // use workspace/config, window/workDoneProgress, etc.
      textDocument: {
        synchronization: { dynamicRegistration: false },
        publishDiagnostics: { relatedInformation: false },
      },
    };
    this.log = options.log ?? (() => {});

    this.dataListener = (chunk) => this.onData(chunk);
    this.process.stdout.on("data", this.dataListener);
  }

  // --- lifecycle ---

  /**
   * Send the `initialize` request + `initialized` notification.
   * Must be called once before any of the 4 ops. Returns the
   * server's capabilities (for future use; v0 ignores them).
   */
  async initialize(): Promise<Record<string, unknown>> {
    this.assertOpen();
    const result = await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: this.clientCapabilities,
      workspaceFolders: null,
    });
    await this.sendNotification("initialized", {});
    this._initialized = true;
    this.log(`initialized; server capabilities=${JSON.stringify(result).slice(0, 200)}`);
    return (result ?? {}) as Record<string, unknown>;
  }

  async close(): Promise<void> {
    if (this._closing || this._closed) return;
    this._closing = true;
    try {
      if (this._initialized) {
        try {
          await this.sendRequest("shutdown", null);
          await this.sendNotification("exit", null);
        } catch (e) {
          // Server may already be dead; the shutdown /
          // exit dance is best-effort.
          this.log(`shutdown/exit failed: ${(e as Error).message}`);
        }
      }
      this.process.stdin.end();
    } finally {
      // Stop listening to the server's stdout AFTER
      // shutdown completes — we needed to receive the
      // shutdown response.
      this.process.stdout.off("data", this.dataListener);
      // Reject any outstanding requests so callers don't hang.
      for (const { reject } of this.pending.values()) {
        reject(new Error("StdioLspClient: closed"));
      }
      this.pending.clear();
      this.process.kill();
      this._closed = true;
    }
  }

  // --- 4 ops ---

  async definition(
    file: string,
    line: number,
    column: number,
  ): Promise<ReadonlyArray<LspLocation>> {
    this.assertInitialized();
    const result = await this.sendRequest("textDocument/definition", {
      textDocument: { uri: pathToUri(file) },
      position: { line, character: column },
    });
    return normalizeLocations(result);
  }

  async references(
    file: string,
    line: number,
    column: number,
  ): Promise<ReadonlyArray<LspLocation>> {
    this.assertInitialized();
    const result = await this.sendRequest("textDocument/references", {
      textDocument: { uri: pathToUri(file) },
      position: { line, character: column },
      context: { includeDeclaration: true },
    });
    return normalizeLocations(result);
  }

  async hover(
    file: string,
    line: number,
    column: number,
  ): Promise<LspHover | null> {
    this.assertInitialized();
    const result = (await this.sendRequest("textDocument/hover", {
      textDocument: { uri: pathToUri(file) },
      position: { line, character: column },
    })) as { contents: unknown } | null;
    if (!result) return null;
    return {
      file,
      line,
      column,
      contents: extractHoverContents(result.contents),
    };
  }

  async diagnostics(file: string): Promise<ReadonlyArray<LspDiagnostic>> {
    this.assertInitialized();
    this.assertOpen();
    // Diagnostics are pushed by the server via
    // `textDocument/publishDiagnostics`. We don't request;
    // we read what the server has sent.
    return this.diagnosticsMap.get(file) ?? [];
  }

  // --- internals ---

  private assertOpen(): void {
    if (this._closed) {
      throw new Error("StdioLspClient: method called after close()");
    }
  }

  private assertInitialized(): void {
    if (!this._initialized) {
      throw new Error("StdioLspClient: call initialize() first");
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    this.assertOpen();
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeMessage(msg);
    });
  }

  private sendNotification(method: string, params: unknown): Promise<void> {
    this.assertOpen();
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.writeMessage(msg);
    return Promise.resolve();
  }

  private writeMessage(msg: JsonRpcMessage): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    this.process.stdin.write(header + body);
  }

  private onData(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.buffer = Buffer.concat([this.buffer, buf]);
    this.drainBuffer();
  }

  /**
   * Parse as many complete LSP messages as possible from
   * the buffer. Headers and bodies are removed as consumed;
   * the buffer keeps any partial message.
   */
  private drainBuffer(): void {
    while (true) {
      // Find the end of the header section.
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headerSection = this.buffer
        .subarray(0, headerEnd)
        .toString("utf8");
      const contentLength = parseContentLength(headerSection);
      if (contentLength === null) {
        this.log(`StdioLspClient: bad header: ${headerSection.slice(0, 80)}`);
        // Drop the bad header and try again.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const totalLength = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalLength) return; // wait for more
      const body = this.buffer
        .subarray(headerEnd + 4, totalLength)
        .toString("utf8");
      this.buffer = this.buffer.subarray(totalLength);
      try {
        this.handleMessage(JSON.parse(body) as JsonRpcMessage);
      } catch (e) {
        this.log(`StdioLspClient: parse error: ${(e as Error).message}`);
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      // It's a response to one of our requests.
      const response = msg as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) {
        this.log(`StdioLspClient: response for unknown id ${response.id}`);
        return;
      }
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(
          new Error(
            `LSP error ${response.error.code}: ${response.error.message}`,
          ),
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    if ("id" in msg && "method" in msg) {
      // It's a server-initiated request. We don't support
      // any in v0; reply with a `null` result (LSP convention
      // for "method unknown / not supported").
      this.writeMessage({
        jsonrpc: "2.0",
        id: (msg as JsonRpcServerRequest).id,
        result: null,
      });
      this.log(
        `StdioLspClient: ignoring server request ${(msg as JsonRpcServerRequest).method}`,
      );
      return;
    }
    if ("method" in msg) {
      // It's a server-initiated notification.
      this.handleNotification(msg as JsonRpcNotification);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as {
        uri: string;
        diagnostics: Array<{
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
          severity?: number;
          message: string;
          code?: string | number;
          source?: string;
        }>;
      };
      const file = uriToPath(params.uri);
      const diags: LspDiagnostic[] = params.diagnostics.map((d) => ({
        file,
        line: d.range.start.line,
        column: d.range.start.character,
        endLine: d.range.end.line,
        endColumn: d.range.end.character,
        severity: severityFromInt(d.severity),
        message: d.message,
        ...(d.code !== undefined ? { code: d.code } : {}),
        ...(d.source !== undefined ? { source: d.source } : {}),
      }));
      if (diags.length === 0) {
        this.diagnosticsMap.delete(file);
      } else {
        this.diagnosticsMap.set(file, diags);
      }
      return;
    }
    // Other notifications (window/logMessage, $/progress,
    // etc.) are ignored in v0.
    this.log(`StdioLspClient: ignoring notification ${msg.method}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a file path to a `file://` URI. The host should
 * pass absolute paths; relative paths are resolved against
 * the LSP root (we don't track that here, so we just
 * forward).
 */
function pathToUri(file: string): string {
  if (file.startsWith("file://")) return file;
  // Encode each path segment so spaces / unicode work.
  const encoded = file
    .split("/")
    .map((seg, i) => (i === 0 && seg === "" ? "" : encodeURIComponent(seg)))
    .join("/");
  return `file://${encoded}`;
}

/** Inverse of `pathToUri`. */
function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const path = uri.slice("file://".length);
  return path.split("/").map(decodeURIComponent).join("/");
}

/** Parse a `Content-Length: N` header. Returns null on bad input. */
function parseContentLength(headerSection: string): number | null {
  for (const line of headerSection.split("\r\n")) {
    const m = /^Content-Length:\s*(\d+)\s*$/i.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * LSP `definition` / `references` return `Location[] | Location | null`.
 * Normalize to a uniform `LspLocation[]`.
 */
function normalizeLocations(
  raw: unknown,
): ReadonlyArray<LspLocation> {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((loc) => loc as { uri: string; range?: { start: { line: number; character: number }; end?: { line: number; character: number } } })
    .map((loc) => {
      const file = uriToPath(loc.uri);
      const start = loc.range?.start ?? { line: 0, character: 0 };
      const end = loc.range?.end;
      return {
        file,
        line: start.line,
        column: start.character,
        ...(end
          ? { endLine: end.line, endColumn: end.character }
          : {}),
      };
    });
}

/** LSP severity is 1=Error, 2=Warning, 3=Info, 4=Hint. */
function severityFromInt(n: number | undefined): LspDiagnostic["severity"] {
  switch (n) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "warning";
  }
}

/** Extract the human-readable contents from an LSP hover result. */
function extractHoverContents(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((item) => extractHoverContents(item)).join("\n\n");
  }
  if (c && typeof c === "object") {
    const obj = c as { language?: string; value?: string };
    if (typeof obj.value === "string") return obj.value;
  }
  return JSON.stringify(c);
}
