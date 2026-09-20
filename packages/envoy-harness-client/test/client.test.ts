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

import { EnvoyHarnessClient, EHUI_PANELS, createEhuiDataSource } from "../src/index.js";

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
          {
            id: "p2",
            model: "claude-instant",
            capabilities: ["research"],
            endpoint: "127.0.0.1:18123",
          },
        ],
      }),
    });

    const peers = await pair.client.listPeers();
    expect(peers).toEqual([
      { id: "p1", model: "deepseek-chat" },
      {
        id: "p2",
        model: "claude-instant",
        capabilities: ["research"],
        endpoint: "127.0.0.1:18123",
      },
    ]);
    expect(await pair.client.listConfiguredPeers()).toEqual([
      { id: "p2", endpoint: "127.0.0.1:18123" },
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

  it("drives the project registry + background-child surface (ACP)", async () => {
    const pair = pairedClientAndServer();
    const calls: unknown[] = [];
    const backend = {
      createSession: async () => ({ sessionId: "s1" }),
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: () => undefined,
      listWorkspaces: async () => ({
        workspaces: [
          {
            path: "/p",
            name: "P",
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      addWorkspace: async (p: { path: string; name?: string }) => {
        calls.push(["add", p]);
        return {
          workspace: {
            path: p.path,
            name: p.name ?? "p",
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        };
      },
      removeWorkspace: async (p: { path: string }) => ({
        removed: p.path === "/p",
      }),
      listSessionAgents: async () => ({
        output: "sub-agents: 1 (1 running)",
        agents: [
          {
            id: "11111111-2222-3333-4444-555555555555",
            capabilityTag: "review",
            objective: "check the diff",
            status: "running",
            startedAt: "2026-01-01T00:00:00.000Z",
            steerable: true,
            outputPreview: "half way through",
          },
        ],
      }),
      sendAgentMessage: async (p: unknown) => {
        calls.push(["send", p]);
        return { queued: true, status: "running" };
      },
      interruptAgent: async (p: unknown) => {
        calls.push(["interrupt", p]);
        return { interrupted: true, status: "failed" };
      },
    } as unknown as Parameters<typeof attachAcpServer>[0]["backend"];
    attachAcpServer({ connection: pair.server, backend });
    await pair.client.initialize();

    expect((await pair.client.listWorkspaces())[0]?.name).toBe("P");
    await pair.client.addWorkspace("/q", "Q");
    expect(calls.at(-1)).toEqual(["add", { path: "/q", name: "Q" }]);
    expect(await pair.client.removeWorkspace("/p")).toBe(true);
    expect(await pair.client.removeWorkspace("/nope")).toBe(false);

    const agents = await pair.client.sessionAgents("s1");
    expect(agents.output).toContain("sub-agents: 1");
    // The full handle id and the live preview — never parsed out of `output`.
    expect(agents.agents?.[0]?.id).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(agents.agents?.[0]?.outputPreview).toBe("half way through");
    // The legacy text accessor still works.
    expect(await pair.client.listSessionAgents("s1")).toContain("sub-agents: 1");

    expect(await pair.client.sendAgentMessage("s1", "a1", "go")).toEqual({
      queued: true,
      status: "running",
    });
    expect(await pair.client.interruptAgent("s1", "a1", "stop")).toEqual({
      interrupted: true,
      status: "failed",
    });
    pair.close();
  });
});

describe("EHUI client hooks", () => {
  it("EHUI_PANELS lists mesh panels with wire methods", () => {
    const ids = EHUI_PANELS.map((p) => p.id);
    expect(ids).toContain("plan");
    expect(ids).toContain("git-diff");
    expect(ids).toContain("mesh");
  });

  it("createEhuiDataSource delegates to client methods", async () => {
    const pair = pairedClientAndServer();
    attachAcpServer({
      connection: pair.server,
      backend: createFakeSessionBackend(),
    });
    await pair.client.initialize();
    const { sessionId } = await pair.client.acpNewSession();
    const ehui = createEhuiDataSource(pair.client, sessionId);
    expect(ehui.sessionId).toBe(sessionId);
    const cluster = await ehui.clusterStatus();
    expect(cluster.peers).toBeDefined();
    pair.close();
  });
});
