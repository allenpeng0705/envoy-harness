/**
 * Hermetic tests for the ACP WebSocket bridge (no real LLM).
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  AutoFrameDecoder,
  encodeFrame,
  encodeNdjsonFrame,
  FrameDecoder,
} from "@envoymesh/envoy-harness";
import { resolveHarnessAcpCommand } from "../src/server/spawn.js";

describe("resolveHarnessAcpCommand", () => {
  it("includes --acp and forwards extra args", () => {
    const resolved = resolveHarnessAcpCommand(["--provider", "openai"]);
    expect(resolved.args).toContain("--acp");
    expect(resolved.args).toContain("--provider");
    expect(resolved.args).toContain("openai");
  });
});

describe("ACP framing (bridge contract)", () => {
  it("encodes/decodes Content-Length initialize", () => {
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

  it("decodes NDJSON replies the way --acp emits them", () => {
    const reply = {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    };
    // Bare JSON + newline (no Content-Length) — the ACP default dialect.
    const decoder = new AutoFrameDecoder();
    decoder.feed(Buffer.from(`${JSON.stringify(reply)}\n`, "utf8"));
    expect(decoder.take()).toEqual([reply]);
    expect(decoder.dialect).toBe("ndjson");
  });

  it("relays browser JSON ↔ NDJSON like the WS bridge", async () => {
    const stdin = new PassThrough();
    const fromBrowser = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    };
    stdin.write(encodeNdjsonFrame(fromBrowser));

    const decoder = new AutoFrameDecoder();
    const got = await new Promise<unknown>((resolve) => {
      stdin.on("data", (chunk: Buffer) => {
        decoder.feed(chunk);
        const msgs = decoder.take();
        if (msgs.length > 0) resolve(msgs[0]);
      });
    });
    expect(got).toEqual(fromBrowser);

    const reply = {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    };
    const outDecoder = new AutoFrameDecoder();
    outDecoder.feed(encodeNdjsonFrame(reply));
    expect(outDecoder.take()).toEqual([reply]);
  });
});
