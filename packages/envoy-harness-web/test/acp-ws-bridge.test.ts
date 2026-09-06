/**
 * Hermetic tests for the ACP WebSocket bridge (no real LLM).
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { encodeFrame, FrameDecoder } from "@envoymesh/envoy-harness";
import { resolveHarnessAcpCommand } from "../src/server/spawn.js";

describe("resolveHarnessAcpCommand", () => {
  it("includes --acp and forwards extra args", () => {
    const resolved = resolveHarnessAcpCommand(["--provider", "openai"]);
    expect(resolved.args).toContain("--acp");
    expect(resolved.args).toContain("--provider");
    expect(resolved.args).toContain("openai");
  });
});

describe("Content-Length frame round-trip (bridge contract)", () => {
  it("encodes and decodes a JSON-RPC initialize", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    };
    const frame = encodeFrame(msg);
    const decoder = new FrameDecoder();
    decoder.feed(frame);
    expect(decoder.take()).toEqual([msg]);
  });

  it("relays JSON text ↔ framed bytes like the WS bridge", async () => {
    // Simulate: browser JSON → encodeFrame → stdin; stdout frames → JSON.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const fromBrowser = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    };
    stdin.write(encodeFrame(fromBrowser));

    const decoder = new FrameDecoder();
    const got = await new Promise<unknown>((resolve) => {
      stdin.on("data", (chunk: Buffer) => {
        decoder.feed(chunk);
        const msgs = decoder.take();
        if (msgs.length > 0) resolve(msgs[0]);
      });
    });
    expect(got).toEqual(fromBrowser);

    // Child reply framed on stdout → browser JSON
    const reply = {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    };
    const outDecoder = new FrameDecoder();
    stdout.write(encodeFrame(reply));
    const outGot = await new Promise<unknown>((resolve) => {
      stdout.on("data", (chunk: Buffer) => {
        outDecoder.feed(chunk);
        const msgs = outDecoder.take();
        if (msgs.length > 0) resolve(msgs[0]);
      });
    });
    expect(JSON.stringify(outGot)).toBe(JSON.stringify(reply));
    void EventEmitter;
  });
});
