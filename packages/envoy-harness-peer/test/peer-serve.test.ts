/**
 * `envoy-peer serve` CLI tests — arg parsing, demo adapter, and a real
 * TCP round-trip (self-skips where localhost binding is blocked).
 */

import { createServer, type Server } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { connectPeerClient } from "../src/index.js";
import {
  createDemoAdapter,
  loadAdapterFromFile,
  parseServeArgs,
  startPeerServer,
} from "../src/cli/serve.js";

describe("parseServeArgs", () => {
  it("defaults host/port/peer id", () => {
    expect(parseServeArgs([])).toEqual({
      host: "0.0.0.0",
      port: 8123,
      peerId: "envoy-peer",
    });
  });

  it("parses all flags", () => {
    expect(
      parseServeArgs([
        "--host",
        "127.0.0.1",
        "--port",
        "9000",
        "--adapter",
        "./adapter.mjs",
        "--peer-id",
        "p1",
        "--model",
        "deepseek-chat",
        "--owner-id",
        "envoy:owner:p1",
        "--verify-after-execute",
      ]),
    ).toEqual({
      host: "127.0.0.1",
      port: 9000,
      adapterFile: "./adapter.mjs",
      peerId: "p1",
      model: "deepseek-chat",
      ownerId: "envoy:owner:p1",
      verifyAfterExecute: true,
    });
  });

  it("rejects unknown flags and bad ports", () => {
    expect(() => parseServeArgs(["--nope"])).toThrow(/unknown flag/);
    expect(() => parseServeArgs(["--port", "70000"])).toThrow(/--port/);
    expect(() => parseServeArgs(["--host"])).toThrow(/requires a value/);
  });
});

describe("createDemoAdapter", () => {
  it("echoes the objective and passes verification", async () => {
    const adapter = createDemoAdapter({ peerId: "p-demo", model: "demo" });
    const result = await adapter.execute({
      skillId: "demo",
      objective: "hello peer",
      inputArtifacts: [],
      costCeilingUsd: 1,
      deadlineMs: 10_000,
      correlationId: "corr-1",
      signal: new AbortController().signal,
    });
    expect(result.content[0]).toMatchObject({
      kind: "text",
      text: "[demo p-demo] hello peer",
    });
    expect(await adapter.verify({ result, objective: "hello peer" })).toEqual([
      { kind: "pass", score: 1, confidence: "high" },
    ]);
  });
});

describe("loadAdapterFromFile", () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("loads an AgentAdapter default export and a factory default export", async () => {
    dir = await mkdtemp(join(tmpdir(), "envoy-peer-adapter-"));
    const file = join(dir, "adapter.mjs");
    await writeFile(
      file,
      `export default {
        runtime: "envoy-harness",
        describeSkills: () => [],
        buildManifest: async (input) => ({ runtime: "envoy-harness", peerId: input.peerId, ownerId: input.ownerId, skills: [], reputationBySkill: {} }),
        execute: async (input) => ({ skillId: input.skillId, runtime: "envoy-harness", peerId: "p-file", correlationId: input.correlationId, content: [{ kind: "text", text: "from file" }], citations: [], metrics: { durationMs: 0, costUsd: 0 }, completedAt: new Date().toISOString(), signature: "" }),
        verify: async () => [{ kind: "pass", score: 1, confidence: "high" }],
      };`,
    );
    const adapter = await loadAdapterFromFile(file);
    expect(adapter.runtime).toBe("envoy-harness");

    const factoryFile = join(dir, "factory.mjs");
    await writeFile(factoryFile, `export default () => ({\n  runtime: "envoy-harness",\n  describeSkills: () => [],\n  buildManifest: async () => ({}),\n  execute: async () => ({ skillId: "x", runtime: "envoy-harness", peerId: "p", correlationId: "c", content: [], citations: [], metrics: { durationMs: 0, costUsd: 0 }, completedAt: new Date().toISOString(), signature: "" }),\n  verify: async () => [],\n});`);
    const fromFactory = await loadAdapterFromFile(factoryFile);
    expect(fromFactory.runtime).toBe("envoy-harness");
  });
});

// Real TCP round-trip (self-skips when localhost binding is blocked).
let canBind = true;
try {
  const probe: Server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolvePromise());
  });
  probe.close();
} catch {
  canBind = false;
}

describe.skipIf(!canBind)("startPeerServer over TCP", () => {
  it("serves ping + submit to a real connectPeerClient", async () => {
    const started = await startPeerServer({
      adapter: createDemoAdapter({ peerId: "p-serve", model: "deepseek-chat" }),
      identity: { peerId: "p-serve", model: "deepseek-chat" },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const { client, close } = await connectPeerClient({
        host: "127.0.0.1",
        port: started.port,
      });
      try {
        const ping = await client.ping();
        expect(ping).toMatchObject({ ok: true, peerId: "p-serve", model: "deepseek-chat" });
        const result = await client.submit({
          objective: "hello over tcp",
          capabilityTag: "demo",
          costCeilingUsd: 1,
          deadlineMs: 10_000,
        });
        expect(result.status).toBe("completed");
        expect(result.content[0]).toMatchObject({
          type: "text",
          text: "[demo p-serve] hello over tcp",
        });
      } finally {
        close();
      }
    } finally {
      await started.close();
    }
  });
});
