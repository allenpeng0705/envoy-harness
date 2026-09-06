import { describe, expect, it } from "vitest";

import { encodeFrame, FrameDecoder } from "../../src/protocol/index.js";

describe("framing", () => {
  it("round-trips a JSON-RPC message", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "ping", params: { x: 1 } };
    const framed = encodeFrame(msg);
    const dec = new FrameDecoder();
    dec.feed(framed);
    expect(dec.take()).toEqual([msg]);
  });

  it("handles chunked frames", () => {
    const msg = { jsonrpc: "2.0", id: 2, result: "ok" };
    const framed = encodeFrame(msg);
    const dec = new FrameDecoder();
    dec.feed(framed.subarray(0, 10));
    expect(dec.take()).toEqual([]);
    dec.feed(framed.subarray(10));
    expect(dec.take()).toEqual([msg]);
  });

  it("rejects frames larger than the cap (DoS hardening)", () => {
    // The decoder caps frame body size so a malicious peer can't
    // claim Content-Length: 99999999999 and force a huge buffer
    // allocation. Override the cap to a tiny value for the test.
    const dec = new FrameDecoder({ maxBytes: 16 });
    const hugeHeader = Buffer.from("Content-Length: 1024\r\n\r\n", "utf8");
    dec.feed(hugeHeader);
    // The cap check fires on take(), not feed() (the buffer has
    // to accumulate the header first).
    expect(() => dec.take()).toThrow(/frame too large/);
  });

  it("rejects malformed Content-Length (no digits)", () => {
    // The regex `(\d+)` requires digits; values like
    // `Content-Length: -1` and `Content-Length: abc` don't match
    // and fall through to the "missing Content-Length" branch.
    const dec = new FrameDecoder();
    dec.feed(Buffer.from("Content-Length: -1\r\n\r\n", "utf8"));
    expect(() => dec.take()).toThrow(/missing Content-Length/);
    const dec2 = new FrameDecoder();
    dec2.feed(Buffer.from("Content-Length: abc\r\n\r\n", "utf8"));
    expect(() => dec2.take()).toThrow(/missing Content-Length/);
  });
});
