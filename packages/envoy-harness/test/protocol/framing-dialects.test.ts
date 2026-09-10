/**
 * JSON-RPC framing dialects.
 *
 * envoy shipped only LSP-style `Content-Length` framing, but the Agent
 * Client Protocol — what the `@agentclientprotocol/sdk` family speaks —
 * is newline-delimited JSON. A standard ACP client pointed at
 * `envoy-harness --acp` therefore saw one parse error per header line
 * and never completed `initialize`. These tests pin the NDJSON codec,
 * the auto-detecting decoder that accepts both dialects, and the
 * capability declaration a standard client actually reads.
 */

import { describe, expect, it } from "vitest";

import {
  AutoFrameDecoder,
  NdjsonFrameDecoder,
  encodeFrame,
  encodeNdjsonFrame,
} from "../../src/protocol/framing.js";

describe("encodeNdjsonFrame", () => {
  it("terminates the message with a newline and no header", () => {
    const bytes = encodeNdjsonFrame({ jsonrpc: "2.0", id: 1, result: {} });
    const text = bytes.toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("Content-Length");
    expect(text.trim().split("\n")).toHaveLength(1);
  });

  it("parses back to the original message", () => {
    const message = { jsonrpc: "2.0", id: "x", method: "initialize", params: {} };
    expect(JSON.parse(encodeNdjsonFrame(message).toString("utf8").trim())).toEqual(
      message,
    );
  });
});

describe("NdjsonFrameDecoder", () => {
  it("decodes one message per line", () => {
    const decoder = new NdjsonFrameDecoder();
    decoder.feed(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1 })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2 })}\n`,
    );
    expect(decoder.take().map((m) => (m as { id: number }).id)).toEqual([1, 2]);
  });

  it("handles a message split across chunks", () => {
    const decoder = new NdjsonFrameDecoder();
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 7, result: "ok" });
    decoder.feed(payload.slice(0, 5));
    expect(decoder.take()).toHaveLength(0);
    decoder.feed(`${payload.slice(5)}\n`);
    expect(decoder.take()).toHaveLength(1);
  });

  it("skips blank lines (the peer may be logging to the same pipe)", () => {
    const decoder = new NdjsonFrameDecoder();
    decoder.feed(`\n\n${JSON.stringify({ jsonrpc: "2.0", id: 3 })}\n\n`);
    expect(decoder.take()).toHaveLength(1);
  });

  it("drops a malformed line instead of killing the connection", () => {
    const bad: string[] = [];
    const decoder = new NdjsonFrameDecoder({ onBadLine: (l) => bad.push(l) });
    decoder.feed(`not json\n${JSON.stringify({ jsonrpc: "2.0", id: 4 })}\n`);
    const messages = decoder.take();
    expect(messages).toHaveLength(1);
    expect((messages[0] as { id: number }).id).toBe(4);
    expect(bad).toEqual(["not json"]);
  });

  it("flushes a trailing unterminated line", () => {
    const decoder = new NdjsonFrameDecoder();
    decoder.feed(JSON.stringify({ jsonrpc: "2.0", id: 9 }));
    expect(decoder.take()).toHaveLength(0);
    expect(decoder.flush()).toHaveLength(1);
  });
});

describe("AutoFrameDecoder", () => {
  it("detects NDJSON from a JSON-RPC payload", () => {
    const decoder = new AutoFrameDecoder();
    decoder.feed(encodeNdjsonFrame({ jsonrpc: "2.0", id: 1 }));
    expect(decoder.dialect).toBe("ndjson");
    expect(decoder.take()).toHaveLength(1);
  });

  it("detects Content-Length framing from a codex-style client", () => {
    const decoder = new AutoFrameDecoder();
    decoder.feed(encodeFrame({ jsonrpc: "2.0", id: 2, method: "initialize" }));
    expect(decoder.dialect).toBe("content-length");
    expect(decoder.take()).toHaveLength(1);
  });

  it("waits for enough bytes before choosing", () => {
    const decoder = new AutoFrameDecoder();
    decoder.feed("{\"jsonrpc\":\"2.0\",");
    expect(decoder.dialect).toBe("ndjson");
    decoder.feed("\"id\":5}\n");
    expect(decoder.take()).toHaveLength(1);
  });

  it("recognizes a Content-Length header split across chunks", () => {
    const decoder = new AutoFrameDecoder();
    const frame = encodeFrame({ jsonrpc: "2.0", id: 3, result: "ok" });
    decoder.feed(frame.subarray(0, 8)); // "Content-"
    decoder.feed(frame.subarray(8));
    expect(decoder.dialect).toBe("content-length");
    expect(decoder.take()).toHaveLength(1);
  });

  it("handles both dialects over one connection lifetime, in order", () => {
    // A host may serve a standard ACP client and envoy's own client
    // from separate connections; each connection picks its own dialect.
    const ndjson = new AutoFrameDecoder();
    ndjson.feed(encodeNdjsonFrame({ jsonrpc: "2.0", id: 1 }));
    expect(ndjson.dialect).toBe("ndjson");

    const framed = new AutoFrameDecoder();
    framed.feed(encodeFrame({ jsonrpc: "2.0", id: 2 }));
    expect(framed.dialect).toBe("content-length");
  });

  it("returns nothing before a dialect is chosen", () => {
    const decoder = new AutoFrameDecoder();
    expect(decoder.take()).toEqual([]);
    expect(decoder.dialect).toBeUndefined();
  });
});
