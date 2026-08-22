/**
 * `envoy-peer ui` — arg parsing, the cluster-console backend, cluster
 * status mapping, scoreboard aggregation, and discovery replay.
 */

import { describe, expect, it } from "vitest";

import {
  aggregateScoreboard,
  buildHealthProvider,
  clusterStatusFromConnect,
  createPeerPoolStatusBackend,
  createInProcessPeerPair,
  createPeerServerHandler,
  createPeerUiBackend,
  parsePeerUiArgs,
  PeerRegistry,
  PeerScoreboard,
} from "../src/index.js";
import { stubAdapter } from "./helpers.js";

describe("parsePeerUiArgs", () => {
  it("parses repeated --peers id@host:port", () => {
    expect(
      parsePeerUiArgs([
        "--peers",
        "p1@127.0.0.1:8100",
        "--peer",
        "p2@127.0.0.1:8101",
        "--connect-timeout-ms",
        "2000",
      ]),
    ).toEqual({
      peers: [
        { id: "p1", endpoint: "127.0.0.1:8100" },
        { id: "p2", endpoint: "127.0.0.1:8101" },
      ],
      connectTimeoutMs: 2000,
    });
  });

  it("rejects malformed peer specs and unknown flags", () => {
    expect(() => parsePeerUiArgs(["--peers", "noport"])).toThrow(
      /<id>@<host:port>/,
    );
    expect(() => parsePeerUiArgs(["--peers", "p1@noport"])).toThrow(
      /<host:port>/,
    );
    expect(() => parsePeerUiArgs(["--nope"])).toThrow(/unknown flag/);
  });
});

function pairFor(id: string, model?: string) {
  return createInProcessPeerPair(
    createPeerServerHandler({
      adapter: stubAdapter(),
      identity: { peerId: id, ...(model !== undefined ? { model } : {}) },
    }),
  );
}

describe("clusterStatusFromConnect", () => {
  it("maps connected peers + failed entries with health", () => {
    const pair = pairFor("p1", "deepseek-chat");
    const registry = new PeerRegistry();
    registry.register({ id: "p1", client: pair.client, model: "deepseek-chat" });
    const status = clusterStatusFromConnect(
      {
        registry,
        connected: ["p1"],
        failed: [{ id: "p2", error: "connect refused" }],
      },
      new Map([["p1", { ok: true, rttMs: 12 }]]),
    );
    expect(status).toEqual({
      peers: [
        {
          id: "p1",
          model: "deepseek-chat",
          health: { ok: true, rttMs: 12 },
        },
        { id: "p2", health: { ok: false, error: "connect refused" } },
      ],
      connected: 1,
      failed: 1,
    });
    pair.close();
  });
});

describe("createPeerUiBackend", () => {
  it("serves cluster status, routing, scoreboard, and discovery replay", async () => {
    const pair = pairFor("p1", "deepseek-chat");
    const registry = new PeerRegistry();
    registry.register({
      id: "p1",
      client: pair.client,
      model: "deepseek-chat",
      capabilities: ["research"],
    });
    const scoreboard = new PeerScoreboard();
    scoreboard.record({
      chainId: "c1",
      subtaskId: "s1",
      workerPeerId: "p1",
      workerRuntime: "envoy-harness",
      skillId: "research",
      verdict: { kind: "pass", score: 0.9, confidence: "high" },
      source: "llm",
      verifierModel: "claude-instant",
      issuedBy: "peer-ui",
      issuedAt: "2026-08-23T00:00:00.000Z",
      signature: "",
    });
    scoreboard.record({
      chainId: "c2",
      subtaskId: "s2",
      workerPeerId: "p1",
      workerRuntime: "envoy-harness",
      skillId: "research",
      verdict: { kind: "fail", reason: "wrong", rollback: true },
      source: "llm",
      verifierModel: "claude-instant",
      issuedBy: "peer-ui",
      issuedAt: "2026-08-23T00:00:01.000Z",
      signature: "",
    });

    const { backend, emitDiscoveryEvent } = createPeerUiBackend({
      registry,
      connected: ["p1"],
      failed: [{ id: "p2", error: "connect refused" }],
      scoreboard,
      healthProvider: async () =>
        new Map([["p1", { ok: true, rttMs: 7, lastPingAt: "now" }]]),
    });

    const cluster = await backend.clusterStatus?.();
    expect(cluster?.peers[0]).toMatchObject({
      id: "p1",
      model: "deepseek-chat",
      health: { ok: true, rttMs: 7 },
    });
    expect(cluster?.peers[1]).toMatchObject({
      id: "p2",
      health: { ok: false, error: "connect refused" },
    });

    expect(backend.routePeer?.({ capabilityTag: "research" })).toMatchObject({
      id: "p1",
      model: "deepseek-chat",
    });
    expect(
      backend.routePeer?.({ capabilityTag: "nothing" }),
    ).toMatchObject({ id: "p1" }); // any-peer fallback

    expect(backend.scoreboardSummary?.()).toEqual([
      {
        workerPeerId: "p1",
        skillId: "research",
        score: 0.45,
        passCount: 1,
        failCount: 1,
        partialCount: 0,
      },
    ]);

    const events: Array<{ type: string; peerId: string }> = [];
    backend.subscribeDiscovery?.((e) => {
      events.push({ type: e.type, peerId: e.peerId });
    });
    expect(events).toEqual([
      { type: "peer.connected", peerId: "p1" },
      { type: "peer.failed", peerId: "p2" },
    ]);
    emitDiscoveryEvent({
      type: "peer.health",
      peerId: "p1",
      rttMs: 3,
      at: "now",
    });
    expect(events).toContainEqual({ type: "peer.health", peerId: "p1" });
    pair.close();
  });
});

describe("buildHealthProvider", () => {
  it("pings registered peers and reports RTT", async () => {
    const pair = pairFor("p1");
    const registry = new PeerRegistry();
    registry.register({ id: "p1", client: pair.client });
    const health = await buildHealthProvider(registry, { ttlMs: 5_000 })();
    const entry = health.get("p1");
    expect(entry?.ok).toBe(true);
    expect(typeof entry?.rttMs).toBe("number");
    expect(entry?.lastPingAt).toBeTruthy();
    pair.close();
  });

  it("emits peer.health events per ping", async () => {
    const pair = pairFor("p1");
    const registry = new PeerRegistry();
    registry.register({ id: "p1", client: pair.client });
    const events: Array<{ type: string; peerId: string; ok: boolean }> = [];
    await buildHealthProvider(registry, {
      ttlMs: 5_000,
      onEvent: (e) => {
        if (e.type === "peer.health") {
          events.push({ type: e.type, peerId: e.peerId, ok: e.ok });
        }
      },
    })();
    expect(events).toContainEqual({
      type: "peer.health",
      peerId: "p1",
      ok: true,
    });
    pair.close();
  });
});

describe("createPeerUiBackend discovery forwarding", () => {
  it("forwards live peer events to discovery subscribers", async () => {
    const pair = pairFor("p1", "deepseek-chat");
    const registry = new PeerRegistry();
    registry.register({ id: "p1", client: pair.client });
    const { backend } = createPeerUiBackend({
      registry,
      connected: ["p1"],
      failed: [],
      onEvent: () => undefined,
    });
    const received: string[] = [];
    backend.subscribeDiscovery?.((e) => received.push(`${e.type}:${e.peerId}`));
    // Initial replay.
    expect(received).toEqual(["peer.connected:p1"]);
    // clusterStatus pings the peer → the health provider emits
    // peer.health → the backend forwards it to subscribers.
    await backend.clusterStatus?.();
    expect(received).toContain("peer.health:p1");
    pair.close();
  });
});

describe("aggregateScoreboard", () => {
  it("sums verdicts per (peer, skill)", () => {
    const scoreboard = new PeerScoreboard();
    scoreboard.record({
      chainId: "c",
      subtaskId: "s",
      workerPeerId: "p1",
      workerRuntime: "envoy-harness",
      skillId: "research",
      verdict: { kind: "pass", score: 1, confidence: "high" },
      source: "rule",
      issuedBy: "x",
      issuedAt: "2026-08-23T00:00:00.000Z",
      signature: "",
    });
    scoreboard.record({
      chainId: "c",
      subtaskId: "s2",
      workerPeerId: "p1",
      workerRuntime: "envoy-harness",
      skillId: "research",
      verdict: { kind: "fail", reason: "no", rollback: true },
      source: "rule",
      issuedBy: "x",
      issuedAt: "2026-08-23T00:00:01.000Z",
      signature: "",
    });
    expect(aggregateScoreboard(scoreboard)).toEqual([
      {
        workerPeerId: "p1",
        skillId: "research",
        score: 0.5,
        passCount: 1,
        failCount: 1,
        partialCount: 0,
      },
    ]);
  });
});

describe("createPeerPoolStatusBackend", () => {
  it("exposes listPeers / clusterStatus / routePeer over a pool", async () => {
    const pair = pairFor("p1", "deepseek-chat");
    const registry = new PeerRegistry();
    registry.register({
      id: "p1",
      client: pair.client,
      model: "deepseek-chat",
      capabilities: ["research"],
    });
    const status = createPeerPoolStatusBackend({
      registry,
      connected: ["p1"],
      failed: [{ id: "p2", error: "connect refused" }],
    });
    expect(status.listPeers()).toEqual([
      { id: "p1", model: "deepseek-chat", capabilities: ["research"] },
    ]);
    expect(status.clusterStatus().connected).toBe(1);
    expect(status.clusterStatus().failed).toBe(1);
    expect(status.routePeer({ capabilityTag: "research" })).toMatchObject({
      id: "p1",
    });
    pair.close();
  });
});
