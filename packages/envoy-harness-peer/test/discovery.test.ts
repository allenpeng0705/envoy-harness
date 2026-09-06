/**
 * R4.18 — pluggable discovery → ManagedPeerCluster rail.
 */

import { describe, expect, it, vi } from "vitest";

import {
  CompositeDiscoverySource,
  createDiscoveryRail,
  createInProcessPeerPair,
  createPeerServerHandler,
  FakeDiscoverySource,
  ManagedPeerCluster,
  MeshFeedDiscoverySource,
  MdnsDiscoverySource,
  StaticDiscoverySource,
  type PeerClient,
} from "../src/index.js";
import type { connectPeerClient } from "../src/tcp.js";
import { stubAdapter } from "./helpers.js";

function inProcessConnect(
  peers: Map<string, { client: PeerClient; close(): void }>,
): typeof connectPeerClient {
  return (async (opts) => {
    const key = `${opts.host}:${opts.port}`;
    const hit = peers.get(key);
    if (hit === undefined) {
      throw new Error(`no in-process peer at ${key}`);
    }
    return { client: hit.client, close: hit.close };
  }) as unknown as typeof connectPeerClient;
}

describe("R4.18 discovery rail", () => {
  it("fake source publishes peer and cluster rail connects hermetically", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({}),
        identity: { peerId: "p-discovered", model: "deepseek-chat" },
      }),
    );
    const endpoints = new Map([
      [
        "127.0.0.1:19001",
        {
          client: pair.client,
          close: () => {
            /* keep pair open until suite ends */
          },
        },
      ],
    ]);

    const events: string[] = [];
    const cluster = new ManagedPeerCluster({
      connect: inProcessConnect(endpoints),
      onEvent: (e) => {
        if (e.type === "peer.connected" || e.type === "peer.disconnected") {
          events.push(`${e.type}:${e.peerId}`);
        }
      },
    });

    const fake = new FakeDiscoverySource();
    const rail = createDiscoveryRail({
      cluster,
      sources: [fake],
    });
    await rail.start();

    expect(cluster.connected).toEqual([]);
    fake.publish({
      id: "p-discovered",
      endpoint: "127.0.0.1:19001",
      model: "deepseek-chat",
      capabilities: ["research"],
    });
    // Drain serial connect queue.
    await vi.waitFor(() => {
      expect(cluster.connected).toEqual(["p-discovered"]);
    });
    expect(cluster.registry.get("p-discovered")?.model).toBe("deepseek-chat");
    expect(events).toContain("peer.connected:p-discovered");

    const status = cluster.clusterStatus();
    expect(status.peers.some((p) => p.id === "p-discovered")).toBe(true);

    fake.revoke("p-discovered");
    await vi.waitFor(() => {
      expect(cluster.connected).toEqual([]);
    });
    expect(events).toContain("peer.disconnected:p-discovered");

    rail.stop();
    pair.close();
  });

  it("static source connects configured peers on start", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({}),
        identity: { peerId: "static-1" },
      }),
    );
    const endpoints = new Map([
      [
        "127.0.0.1:19002",
        { client: pair.client, close: () => undefined },
      ],
    ]);
    const cluster = new ManagedPeerCluster({
      connect: inProcessConnect(endpoints),
    });
    const rail = createDiscoveryRail({
      cluster,
      sources: [
        new StaticDiscoverySource([
          { id: "static-1", endpoint: "127.0.0.1:19002" },
        ]),
      ],
    });
    await rail.start();
    expect(cluster.connected).toEqual(["static-1"]);
    rail.stop();
    pair.close();
  });

  it("mesh feed and mdns browser plug into the same rail", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({}),
        identity: { peerId: "mesh-1" },
      }),
    );
    const endpoints = new Map([
      ["10.0.0.2:4000", { client: pair.client, close: () => undefined }],
    ]);
    const cluster = new ManagedPeerCluster({
      connect: inProcessConnect(endpoints),
    });

    const mesh = new MeshFeedDiscoverySource();
    const mdns = new MdnsDiscoverySource({
      browser: (emit) => {
        emit({
          kind: "found",
          peer: {
            id: "mdns-skip",
            endpoint: "10.0.0.99:1",
            source: "mdns",
          },
        });
      },
    });
    // Composite: mesh only has a real endpoint; mdns will fail-open.
    const rail = createDiscoveryRail({
      cluster,
      sources: [new CompositeDiscoverySource([mesh, mdns])],
    });
    await rail.start();
    mesh.feed([{ id: "mesh-1", endpoint: "10.0.0.2:4000" }]);
    await vi.waitFor(() => {
      expect(cluster.connected).toContain("mesh-1");
    });
    expect(cluster.failed.some((f) => f.id === "mdns-skip")).toBe(true);
    rail.stop();
    pair.close();
  });

  it("keeps peer connected when only one of two sources revokes", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({}),
        identity: { peerId: "shared" },
      }),
    );
    const endpoints = new Map([
      ["127.0.0.1:19003", { client: pair.client, close: () => undefined }],
    ]);
    const cluster = new ManagedPeerCluster({
      connect: inProcessConnect(endpoints),
    });
    const a = new FakeDiscoverySource();
    const b = new FakeDiscoverySource();
    const rail = createDiscoveryRail({
      cluster,
      sources: [new CompositeDiscoverySource([a, b])],
    });
    await rail.start();
    a.publish({ id: "shared", endpoint: "127.0.0.1:19003" });
    b.publish({ id: "shared", endpoint: "127.0.0.1:19003" });
    await vi.waitFor(() => {
      expect(cluster.connected).toEqual(["shared"]);
    });
    a.revoke("shared");
    // Give the serial queue a tick — must stay connected.
    await new Promise((r) => setTimeout(r, 20));
    expect(cluster.connected).toEqual(["shared"]);
    b.revoke("shared");
    await vi.waitFor(() => {
      expect(cluster.connected).toEqual([]);
    });
    rail.stop();
    pair.close();
  });

  it("allows retry after a failed start", async () => {
    const good = new FakeDiscoverySource();
    const bad: import("../src/discovery.js").DiscoverySource = {
      kind: "fake",
      start() {
        throw new Error("boom");
      },
      stop() {
        /* noop */
      },
    };
    const cluster = new ManagedPeerCluster({
      connect: inProcessConnect(new Map()),
    });
    const rail = createDiscoveryRail({
      cluster,
      sources: [good, bad],
    });
    await expect(rail.start()).rejects.toThrow(/boom/);
    expect(rail.running).toBe(false);

    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({}),
        identity: { peerId: "retry" },
      }),
    );
    const endpoints = new Map([
      ["127.0.0.1:19004", { client: pair.client, close: () => undefined }],
    ]);
    const cluster2 = new ManagedPeerCluster({
      connect: inProcessConnect(endpoints),
    });
    const ok = new FakeDiscoverySource();
    const rail2 = createDiscoveryRail({
      cluster: cluster2,
      sources: [ok],
    });
    await rail2.start();
    expect(rail2.running).toBe(true);
    ok.publish({ id: "retry", endpoint: "127.0.0.1:19004" });
    await vi.waitFor(() => {
      expect(cluster2.connected).toEqual(["retry"]);
    });
    rail2.stop();
    pair.close();
  });
});
