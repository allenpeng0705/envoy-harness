/**
 * Client package tests — in-process against harness protocol servers.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  attachAcpServer,
  attachSdkServer,
  createFakeSessionBackend,
  JsonRpcConnection,
} from "@envoymesh/envoy-harness";

import { EnvoyHarnessClient } from "../src/index.js";

function pairedClientAndServer(): {
  client: EnvoyHarnessClient;
  server: JsonRpcConnection;
  close(): void;
} {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const server = new JsonRpcConnection({ input: c2s, output: s2c });
  const client = new EnvoyHarnessClient({
    input: s2c,
    output: c2s,
    onPermissionRequest: async () => "allow",
  });
  return {
    client,
    server,
    close() {
      client.close();
      server.close();
      c2s.destroy();
      s2c.destroy();
    },
  };
}

describe("EnvoyHarnessClient", () => {
  it("drives SDK dialect end-to-end", async () => {
    const pair = pairedClientAndServer();
    attachSdkServer({
      connection: pair.server,
      backend: createFakeSessionBackend({
        tools: [{ name: "bash", description: "shell" }],
      }),
    });

    const { sessionId } = await pair.client.createSession();
    const tools = await pair.client.listTools();
    expect(tools[0]?.name).toBe("bash");
    const result = await pair.client.prompt(sessionId, "ping");
    expect(result.stopReason).toBe("end_turn");
    pair.close();
  });

  it("lists peers over the SDK dialect", async () => {
    const pair = pairedClientAndServer();
    attachSdkServer({
      connection: pair.server,
      backend: createFakeSessionBackend({
        peers: [
          { id: "p1", model: "deepseek-chat" },
          { id: "p2", model: "claude-instant", capabilities: ["research"] },
        ],
      }),
    });

    const peers = await pair.client.listPeers();
    expect(peers).toEqual([
      { id: "p1", model: "deepseek-chat" },
      { id: "p2", model: "claude-instant", capabilities: ["research"] },
    ]);
    pair.close();
  });

  it("lists peers over the ACP dialect (empty when the backend has none)", async () => {
    const pair = pairedClientAndServer();
    attachAcpServer({
      connection: pair.server,
      backend: createFakeSessionBackend(),
    });
    await pair.client.initialize();
    expect(await pair.client.listPeers()).toEqual([]);
    pair.close();
  });

  it("reads cluster status, team jobs, and scoreboard over the SDK dialect", async () => {
    const pair = pairedClientAndServer();
    attachSdkServer({
      connection: pair.server,
      backend: createFakeSessionBackend({
        clusterStatus: {
          peers: [
            {
              id: "p1",
              model: "deepseek-chat",
              capabilities: ["research"],
              health: { ok: true, rttMs: 12, lastPingAt: "2026-08-23T00:00:00.000Z" },
            },
          ],
          connected: 1,
          failed: 0,
        },
        teamJobs: [
          {
            jobId: "job-1",
            status: "running",
            createdAt: "2026-08-23T00:00:00.000Z",
            costUsd: 0.5,
            agents: [
              {
                id: "a1",
                host: "peer://p1",
                model: "deepseek-chat",
                status: "running",
              },
            ],
          },
        ],
        scoreboard: [
          {
            workerPeerId: "p1",
            skillId: "research",
            score: 0.9,
            passCount: 9,
            failCount: 1,
            partialCount: 0,
          },
        ],
      }),
    });

    const cluster = await pair.client.clusterStatus();
    expect(cluster.connected).toBe(1);
    expect(cluster.peers[0]).toMatchObject({
      id: "p1",
      model: "deepseek-chat",
      health: { ok: true, rttMs: 12 },
    });
    const jobs = await pair.client.teamJobs();
    expect(jobs[0]?.agents[0]).toMatchObject({
      id: "a1",
      host: "peer://p1",
      status: "running",
    });
    const entries = await pair.client.scoreboardSummary();
    expect(entries[0]).toMatchObject({
      workerPeerId: "p1",
      score: 0.9,
      passCount: 9,
    });
    pair.close();
  });

  it("returns empty cluster/team/scoreboard over ACP when the backend has none", async () => {
    const pair = pairedClientAndServer();
    attachAcpServer({
      connection: pair.server,
      backend: createFakeSessionBackend(),
    });
    await pair.client.initialize();
    expect(await pair.client.clusterStatus()).toEqual({
      peers: [],
      connected: 0,
      failed: 0,
    });
    expect(await pair.client.teamJobs()).toEqual([]);
    expect(await pair.client.scoreboardSummary()).toEqual([]);
    pair.close();
  });

  it("receives discovery events pushed by the host (SDK dialect)", async () => {
    const pair = pairedClientAndServer();
    const received: Array<{ type: string; peerId: string }> = [];
    attachSdkServer({
      connection: pair.server,
      backend: createFakeSessionBackend({
        discoveryEvents: [
          {
            type: "peer.connected",
            peerId: "p1",
            model: "deepseek-chat",
            at: "2026-08-23T00:00:00.000Z",
          },
          {
            type: "peer.failed",
            peerId: "p2",
            error: "connect refused",
            at: "2026-08-23T00:00:01.000Z",
          },
        ],
      }),
    });

    const unsubscribe = await pair.client.subscribeDiscovery((event) => {
      received.push({ type: event.type, peerId: event.peerId });
    });
    expect(received).toEqual([
      { type: "peer.connected", peerId: "p1" },
      { type: "peer.failed", peerId: "p2" },
    ]);
    unsubscribe();
    pair.close();
  });

  it("receives discovery events pushed by the host (ACP dialect)", async () => {
    const pair = pairedClientAndServer();
    const received: string[] = [];
    attachAcpServer({
      connection: pair.server,
      backend: createFakeSessionBackend({
        discoveryEvents: [
          {
            type: "peer.connected",
            peerId: "p1",
            at: "2026-08-23T00:00:00.000Z",
          },
        ],
      }),
    });
    await pair.client.initialize();
    const unsubscribe = await pair.client.subscribeDiscovery((event) => {
      received.push(event.peerId);
    });
    expect(received).toEqual(["p1"]);
    unsubscribe();
    pair.close();
  });

  it("previews routing over the SDK dialect", async () => {
    const pair = pairedClientAndServer();
    attachSdkServer({
      connection: pair.server,
      backend: createFakeSessionBackend({
        routePeer: (input) =>
          input.capabilityTag === "research"
            ? { id: "p1", model: "deepseek-chat" }
            : undefined,
      }),
    });

    const peer = await pair.client.routePeer("research");
    expect(peer).toEqual({ id: "p1", model: "deepseek-chat" });
    expect(await pair.client.routePeer("unknown")).toBeUndefined();
    pair.close();
  });

  it("ACP initialize + prompt", async () => {
    const pair = pairedClientAndServer();
    attachAcpServer({
      connection: pair.server,
      backend: createFakeSessionBackend(),
    });
    const init = await pair.client.initialize();
    expect(init.protocolVersion).toBe(1);
    const { sessionId } = await pair.client.acpNewSession();
    const result = await pair.client.prompt(sessionId, "acp");
    expect(result.messages.at(-1)).toMatchObject({ text: "echo:acp" });
    pair.close();
  });
});
