/**
 * F9.2.2 tests — `StdioLspClient` over a `FakeStdio`.
 *
 * Covers the LSP wire protocol (JSON-RPC 2.0 with
 * `Content-Length` framing) without a real language
 * server:
 *
 * 1. `initialize` sends the request, reads the response,
 *    sends the `initialized` notification. Server
 *    capabilities round-trip.
 * 2. The 4 ops (`definition`, `references`, `hover`,
 *    `diagnostics`) frame requests correctly and parse
 *    responses correctly.
 * 3. Server-initiated requests get a `null` reply (v0
 *    doesn't handle any).
 * 4. Server-initiated notifications: `publishDiagnostics`
 *    populates the diagnostics map; `diagnostics(file)`
 *    reads it.
 * 5. Concurrent in-flight requests are matched by `id`.
 * 6. `close()` sends `shutdown` + `exit` and kills the
 *    process.
 * 7. Operations before `initialize()` throw.
 * 8. Operations after `close()` throw.
 * 9. Content-Length framing: large messages, multiple
 *    messages in one chunk, partial messages.
 * 10. Path ↔ URI conversion (spaces, unicode).
 * 11. `frameLspMessage` helper.
 */

import { describe, expect, it } from "vitest";

import {
  FakeStdio,
  StdioLspClient,
  frameLspMessage,
  type LspProcess,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a (client, fake) pair with a `rootUri` and optional logger. */
function setup(opts?: { rootUri?: string; log?: (msg: string) => void }) {
  const fake = new FakeStdio();
  const client = new StdioLspClient({
    process: fake as LspProcess,
    rootUri: opts?.rootUri ?? "file:///proj",
    ...(opts?.log ? { log: opts.log } : {}),
  });
  return { client, fake };
}

const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// 1. Content-Length framing
// ---------------------------------------------------------------------------

describe("frameLspMessage", () => {
  it("frames a JSON-RPC message with Content-Length", () => {
    const framed = frameLspMessage({ jsonrpc: "2.0", id: 1, method: "x" });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" });
    expect(framed).toBe(
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
    );
  });

  it("computes byte length (not char length) for unicode", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, params: { s: "中文" } });
    const framed = frameLspMessage(JSON.parse(body));
    // 中文 is 3 bytes each in UTF-8; "中文" = 6 bytes.
    const expectedLen = Buffer.byteLength(body, "utf8");
    expect(framed.startsWith(`Content-Length: ${expectedLen}\r\n\r\n`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. initialize handshake
// ---------------------------------------------------------------------------

describe("StdioLspClient.initialize", () => {
  it("sends initialize + initialized; round-trips server capabilities", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    // Allow the synchronous write to land.
    await flush();
    // Client should have written `initialize` (id=1).
    const initMsg = fake.messagesToServer[0] as {
      jsonrpc: string;
      id: number;
      method: string;
      params: { rootUri: string };
    };
    expect(initMsg.jsonrpc).toBe("2.0");
    expect(initMsg.id).toBe(1);
    expect(initMsg.method).toBe("initialize");
    expect(initMsg.params.rootUri).toBe("file:///proj");
    // Reply with server capabilities.
    fake.sendFromServer({
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: { definitionProvider: true } },
    });
    const caps = await p;
    expect(caps).toEqual({ capabilities: { definitionProvider: true } });
    // The `initialized` notification should have been sent.
    const second = fake.messagesToServer[1] as {
      method: string;
      jsonrpc: string;
    };
    expect(second.method).toBe("initialized");
    expect(second.jsonrpc).toBe("2.0");
  });

  it("rejects on LSP error response", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "bad request" },
    });
    await expect(p).rejects.toThrow(/LSP error -32600: bad request/);
  });
});

// ---------------------------------------------------------------------------
// 3. The 4 ops require initialize
// ---------------------------------------------------------------------------

describe("StdioLspClient ops require initialize", () => {
  it("definition throws if initialize() was not called", async () => {
    const { client } = setup();
    await expect(client.definition("/a.ts", 0, 0)).rejects.toThrow(
      /call initialize\(\) first/,
    );
  });

  it("references throws if initialize() was not called", async () => {
    const { client } = setup();
    await expect(client.references("/a.ts", 0, 0)).rejects.toThrow(
      /call initialize\(\) first/,
    );
  });

  it("hover throws if initialize() was not called", async () => {
    const { client } = setup();
    await expect(client.hover("/a.ts", 0, 0)).rejects.toThrow(
      /call initialize\(\) first/,
    );
  });

  it("diagnostics throws if initialize() was not called", async () => {
    const { client } = setup();
    await expect(client.diagnostics("/a.ts")).rejects.toThrow(
      /call initialize\(\) first/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The 4 ops after initialize
// ---------------------------------------------------------------------------

describe("StdioLspClient ops", () => {
  it("definition sends textDocument/definition + parses single Location", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    // Now call definition.
    const defP = client.definition("/a.ts", 5, 3);
    await flush();
    const msg = fake.messagesToServer.at(-1) as {
      method: string;
      params: {
        textDocument: { uri: string };
        position: { line: number; character: number };
      };
    };
    expect(msg.method).toBe("textDocument/definition");
    expect(msg.params.textDocument.uri).toBe("file:///a.ts");
    expect(msg.params.position).toEqual({ line: 5, character: 3 });
    fake.sendFromServer({
      jsonrpc: "2.0",
      id: 2,
      result: {
        uri: "file:///def.ts",
        range: { start: { line: 10, character: 4 }, end: { line: 10, character: 8 } },
      },
    });
    const got = await defP;
    expect(got).toEqual([
      { file: "/def.ts", line: 10, column: 4, endLine: 10, endColumn: 8 },
    ]);
  });

  it("definition normalizes a Location[] to LspLocation[]", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    const defP = client.definition("/a.ts", 0, 0);
    await flush();
    fake.sendFromServer({
      jsonrpc: "2.0",
      id: 2,
      result: [
        { uri: "file:///x.ts", range: { start: { line: 1, character: 0 } } },
        { uri: "file:///y.ts", range: { start: { line: 2, character: 5 } } },
      ],
    });
    const got = await defP;
    expect(got).toEqual([
      { file: "/x.ts", line: 1, column: 0 },
      { file: "/y.ts", line: 2, column: 5 },
    ]);
  });

  it("definition handles null result (no definition found)", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    const defP = client.definition("/a.ts", 0, 0);
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 2, result: null });
    expect(await defP).toEqual([]);
  });

  it("references sends includeDeclaration: true", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    const refP = client.references("/a.ts", 0, 0);
    await flush();
    const msg = fake.messagesToServer.at(-1) as {
      method: string;
      params: { context: { includeDeclaration: boolean } };
    };
    expect(msg.method).toBe("textDocument/references");
    expect(msg.params.context.includeDeclaration).toBe(true);
    fake.sendFromServer({ jsonrpc: "2.0", id: 2, result: [] });
    expect(await refP).toEqual([]);
  });

  it("hover returns null when server returns null", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    const hP = client.hover("/a.ts", 0, 0);
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 2, result: null });
    expect(await hP).toBeNull();
  });

  it("hover extracts string contents", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    const hP = client.hover("/a.ts", 5, 3);
    await flush();
    fake.sendFromServer({
      jsonrpc: "2.0",
      id: 2,
      result: { contents: "function foo(): void" },
    });
    const got = await hP;
    expect(got?.contents).toBe("function foo(): void");
    expect(got?.file).toBe("/a.ts");
    expect(got?.line).toBe(5);
    expect(got?.column).toBe(3);
  });

  it("hover extracts markdown contents (object.value)", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    const hP = client.hover("/a.ts", 0, 0);
    await flush();
    fake.sendFromServer({
      jsonrpc: "2.0",
      id: 2,
      result: { contents: { language: "ts", value: "```ts\nfoo()\n```" } },
    });
    const got = await hP;
    expect(got?.contents).toBe("```ts\nfoo()\n```");
  });

  it("hover handles contents as an array of strings", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    const hP = client.hover("/a.ts", 0, 0);
    await flush();
    fake.sendFromServer({
      jsonrpc: "2.0",
      id: 2,
      result: { contents: ["first", "second"] },
    });
    const got = await hP;
    expect(got?.contents).toBe("first\n\nsecond");
  });
});

// ---------------------------------------------------------------------------
// 5. publishDiagnostics notification
// ---------------------------------------------------------------------------

describe("StdioLspClient diagnostics (publish-driven)", () => {
  it("diagnostics() returns [] before any server notification", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    expect(await client.diagnostics("/a.ts")).toEqual([]);
  });

  it("publishDiagnostics populates the diagnostics map", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    fake.sendFromServer({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///a.ts",
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 4 },
            },
            severity: 1,
            message: "boom",
            code: 100,
            source: "ts",
          },
        ],
      },
    });
    const got = await client.diagnostics("/a.ts");
    expect(got).toEqual([
      {
        file: "/a.ts",
        line: 0,
        column: 0,
        endLine: 0,
        endColumn: 4,
        severity: "error",
        message: "boom",
        code: 100,
        source: "ts",
      },
    ]);
  });

  it("publishDiagnostics with [] clears the entry", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    // First push, then clear.
    fake.sendFromServer({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///a.ts",
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            severity: 1,
            message: "x",
          },
        ],
      },
    });
    expect(await client.diagnostics("/a.ts")).toHaveLength(1);
    fake.sendFromServer({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///a.ts", diagnostics: [] },
    });
    expect(await client.diagnostics("/a.ts")).toEqual([]);
  });

  it("unknown severity number falls back to 'warning'", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    fake.sendFromServer({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///a.ts",
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            severity: 99,
            message: "x",
          },
        ],
      },
    });
    const got = await client.diagnostics("/a.ts");
    expect(got[0]?.severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// F-fix: didOpen / awaitDiagnostics / request timeout
// ---------------------------------------------------------------------------

describe("StdioLspClient didOpen + awaitDiagnostics", () => {
  async function initialized(opts?: { requestTimeoutMs?: number }) {
    const fake = new FakeStdio();
    const client = new StdioLspClient({
      process: fake as LspProcess,
      rootUri: "file:///proj",
      ...(opts?.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: opts.requestTimeoutMs }
        : {}),
    });
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    return { client, fake };
  }

  it("didOpen sends a textDocument/didOpen notification with the file text", async () => {
    const { client, fake } = await initialized();
    await client.didOpen("/a.ts", "const x = 1;");
    const sent = fake.messagesToServer.find(
      (m) =>
        (m as { method?: string }).method === "textDocument/didOpen",
    ) as { params?: { textDocument?: { uri?: string; text?: string } } };
    expect(sent?.params?.textDocument?.uri).toBe("file:///a.ts");
    expect(sent?.params?.textDocument?.text).toBe("const x = 1;");
  });

  it("awaitDiagnostics resolves when publishDiagnostics arrives", async () => {
    const { client, fake } = await initialized();
    const p = client.awaitDiagnostics("/a.ts");
    fake.sendFromServer({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///a.ts",
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            message: "boom",
          },
        ],
      },
    });
    const got = await p;
    expect(got).toHaveLength(1);
    expect(got[0]?.message).toBe("boom");
  });

  it("awaitDiagnostics times out with the current (possibly empty) state", async () => {
    const { client } = await initialized();
    const got = await client.awaitDiagnostics("/a.ts", 10);
    expect(got).toEqual([]);
  });
});

describe("StdioLspClient request timeout", () => {
  it("rejects a request the server never answers", async () => {
    const { client } = await (async () => {
      const fake = new FakeStdio();
      const client = new StdioLspClient({
        process: fake as LspProcess,
        rootUri: "file:///proj",
        requestTimeoutMs: 20,
      });
      const p = client.initialize();
      await flush();
      fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
      await p;
      return { client, fake };
    })();
    const p = client.definition("/a.ts", 0, 0);
    await expect(p).rejects.toThrow(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrent in-flight requests
// ---------------------------------------------------------------------------

describe("StdioLspClient concurrent requests", () => {
  it("two concurrent requests are matched by id", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    // Fire two requests at once. `definition` is called
    // first → id=2; `references` is called second → id=3.
    const defP = client.definition("/a.ts", 0, 0);
    const refP = client.references("/a.ts", 1, 1);
    await flush();
    // Reply to references (id=3) FIRST, then definition (id=2).
    // The order of replies doesn't matter — the client
    // matches by `id`.
    fake.sendFromServer({
      jsonrpc: "2.0",
      id: 3,
      result: [{ uri: "file:///ref.ts", range: { start: { line: 7, character: 0 } } }],
    });
    fake.sendFromServer({
      jsonrpc: "2.0",
      id: 2,
      result: [{ uri: "file:///def.ts", range: { start: { line: 5, character: 0 } } }],
    });
    expect(await defP).toEqual([{ file: "/def.ts", line: 5, column: 0 }]);
    expect(await refP).toEqual([{ file: "/ref.ts", line: 7, column: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// 7. Server-initiated requests get a null reply
// ---------------------------------------------------------------------------

describe("StdioLspClient server-initiated requests", () => {
  it("replies with null and ignores the method", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    // Server sends a request we don't know.
    fake.sendFromServer({
      jsonrpc: "2.0",
      id: 99,
      method: "client/registerCapability",
      params: {},
    });
    await flush();
    // We should have written a null result for id 99.
    const last = fake.messagesToServer.at(-1) as {
      id: number;
      result: null;
    };
    expect(last.id).toBe(99);
    expect(last.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. close()
// ---------------------------------------------------------------------------

describe("StdioLspClient.close", () => {
  it("sends shutdown + exit + kills the process (when initialized)", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    fake.writesToServer.length = 0; // reset
    fake.killCalls.length = 0;
    const closeP = client.close();
    await flush();
    // Reply to shutdown so close() can proceed to exit.
    fake.sendFromServer({ jsonrpc: "2.0", id: 2, result: null });
    await closeP;
    // We should have written shutdown (id=2), then exit (no id).
    const methods = fake.messagesToServer.map((m) => (m as { method?: string }).method);
    expect(methods).toEqual(["shutdown", "exit"]);
    expect(fake.stdinEnded).toBe(true);
    expect(fake.killCalls.length).toBe(1);
  });

  it("is idempotent", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    fake.killCalls.length = 0;
    // Drive the first close to completion (we have to
    // answer its shutdown request or it hangs).
    const closeP1 = client.close();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 2, result: null });
    await closeP1;
    // The second close is a no-op.
    await client.close();
    expect(fake.killCalls.length).toBe(1);
  });

  it("operations after close throw", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    const closeP = client.close();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 2, result: null });
    await closeP;
    await expect(client.definition("/a.ts", 0, 0)).rejects.toThrow(
      /after close/,
    );
    await expect(client.diagnostics("/a.ts")).rejects.toThrow(/after close/);
  });

  it("close before initialize skips shutdown/exit and just kills", async () => {
    const { client, fake } = setup();
    await client.close();
    // No shutdown / exit was sent.
    expect(fake.messagesToServer).toEqual([]);
    expect(fake.killCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Path ↔ URI conversion
// ---------------------------------------------------------------------------

describe("StdioLspClient path <-> uri", () => {
  it("encodes spaces in file paths", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    const defP = client.definition("/my dir/foo bar.ts", 0, 0);
    await flush();
    const msg = fake.messagesToServer.at(-1) as {
      params: { textDocument: { uri: string } };
    };
    expect(msg.params.textDocument.uri).toBe(
      "file:///my%20dir/foo%20bar.ts",
    );
    fake.sendFromServer({ jsonrpc: "2.0", id: 2, result: null });
    await defP;
  });

  it("encodes unicode in file paths", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    fake.sendFromServer({ jsonrpc: "2.0", id: 1, result: {} });
    await p;
    const defP = client.definition("/中文/a.ts", 0, 0);
    await flush();
    const msg = fake.messagesToServer.at(-1) as {
      params: { textDocument: { uri: string } };
    };
    expect(msg.params.textDocument.uri).toBe(
      "file:///%E4%B8%AD%E6%96%87/a.ts",
    );
    fake.sendFromServer({ jsonrpc: "2.0", id: 2, result: null });
    await defP;
  });
});

// ---------------------------------------------------------------------------
// 10. Multiple frames in one chunk
// ---------------------------------------------------------------------------

describe("StdioLspClient framing", () => {
  it("parses two frames in a single chunk", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    // Concatenate two frames.
    const framed = frameLspMessage({ jsonrpc: "2.0", id: 1, result: {} });
    fake.feedFromServer(framed);
    await p;
    // Send a second frame for the initialized notification's
    // (lack of) response; nothing pending, so it's just
    // ignored. But the parser must not throw.
    const framed2 = frameLspMessage({
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: { type: 3, message: "hi" },
    });
    fake.feedFromServer(framed2);
  });

  it("parses a frame split across two chunks", async () => {
    const { client, fake } = setup();
    const p = client.initialize();
    await flush();
    const framed = frameLspMessage({ jsonrpc: "2.0", id: 1, result: {} });
    // Split in the middle of the body.
    const splitAt = Math.floor(framed.length / 2);
    fake.feedFromServer(framed.slice(0, splitAt));
    // The client is still waiting; the initialize promise
    // should not have resolved yet.
    let resolved = false;
    void p.then(() => { resolved = true; });
    await flush();
    expect(resolved).toBe(false);
    fake.feedFromServer(framed.slice(splitAt));
    await p;
  });
});
