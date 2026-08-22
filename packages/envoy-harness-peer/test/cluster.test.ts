/**
 * R2 — the peer cluster: static discovery + the dynamic cluster
 * submitter (the mesh node's execution pool).
 */

import { createServer, type Server } from "node:net";
import type { Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { JsonRpcConnection } from "@envoymesh/envoy-harness";

import {
  connectPeerClients,
  createInProcessPeerPair,
  createPeerClusterSubmitter,
  createPeerServerHandler,
  PeerRegistry,
} from "../src/index.js";
import type { PeerClient } from "../src/client.js";
import type { connectPeerClient } from "../src/tcp.js";
import { signedResult, stubAdapter } from "./helpers.js";

describe("createPeerClusterSubmitter", () => {
  it("routes by preferredPeerId, then model, then any peer", async () => {
    const deepseek = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({
          execute: async () => signedResult({ peerId: "p-deepseek" }),
        }),
        identity: { peerId: "p-deepseek", model: "deepseek-chat" },
      }),
    );
    const claude = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({
          execute: async () => signedResult({ peerId: "p-claude" }),
        }),
        identity: { peerId: "p-claude", model: "claude-instant" },
      }),
    );
    const registry = new PeerRegistry();
    registry.register({ id: "p-deepseek", client: deepseek.client, model: "deepseek-chat" });
    registry.register({ id: "p-claude", client: claude.client, model: "claude-instant" });
    const cluster = createPeerClusterSubmitter(registry);

    const base = {
      objective: "x",
      capabilityTag: "research",
      costCeilingUsd: 1,
      deadlineMs: 10_000,
    };
    // Model routing isn't a hint field on SubagentInput; preferred wins.
    const byPreferred = await cluster.submit(
      { ...base, preferredPeerId: "p-claude" },
      new AbortController().signal,
    );
    expect(byPreferred.workerPeerId).toBe("p-claude");
    const byAny = await cluster.submit(base, new AbortController().signal);
    expect(["p-deepseek", "p-claude"]).toContain(byAny.workerPeerId);

    deepseek.close();
    claude.close();
  });
});

// Static discovery over TCP (self-skips when localhost binding is blocked).
let canBind = true;
try {
  const probe: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  probe.close();
} catch {
  canBind = false;
}

describe.skipIf(!canBind)("connectPeerClients (static discovery)", () => {
  it("connects configured peers and fails open on bad endpoints", async () => {
    const server = createServer((socket) => {
      new JsonRpcConnection({
        input: socket,
        output: socket,
        onRequest: createPeerServerHandler({
          adapter: stubAdapter(),
          identity: { peerId: "p1", model: "deepseek-chat" },
        }),
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const result = await connectPeerClients([
      { id: "p1", endpoint: `127.0.0.1:${address.port}`, model: "deepseek-chat" },
      { id: "bad", endpoint: "127.0.0.1:1" },
      { id: "malformed", endpoint: "no-port" },
    ]);
    expect(result.connected).toEqual(["p1"]);
    expect(result.failed.map((f) => f.id)).toEqual(["bad", "malformed"]);
    expect(result.registry.list().map((e) => e.id)).toEqual(["p1"]);
    result.closeAll();
    server.close();
  });
});

describe("connectPeerClients (concurrency)", () => {
  it("connects peers concurrently — a stalled endpoint doesn't block the healthy ones", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    // Every connect enters and then waits on its own gate. A sequential
    // implementation would never start endpoint b before a finished, so
    // the wait below would time out (proving concurrency without wall
    // clock assertions).
    const connect = (async (opts: { host: string; port: number }) => {
      started.push(`${opts.host}:${opts.port}`);
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      return {
        client: {} as PeerClient,
        socket: {} as Socket,
        close: () => {},
      };
    }) as unknown as typeof connectPeerClient;

    const pending = connectPeerClients(
      [
        { id: "a", endpoint: "127.0.0.1:4001" },
        { id: "b", endpoint: "127.0.0.1:4002" },
        { id: "bad", endpoint: "no-port" },
      ],
      { connect },
    );

    // Both real endpoints must have STARTED before either resolves.
    await vi.waitFor(() => {
      expect(started).toHaveLength(2);
    });
    for (const r of release) r();

    const result = await pending;
    expect(result.connected).toEqual(["a", "b"]);
    expect(result.failed.map((f) => f.id)).toEqual(["bad"]);
    result.closeAll();
  });

  it("emits connected / failed / disconnected lifecycle events", async () => {
    const events: string[] = [];
    const connect = (async () => ({
      client: {} as PeerClient,
      socket: {} as Socket,
      close: () => {},
    })) as unknown as typeof connectPeerClient;

    const result = await connectPeerClients(
      [
        { id: "a", endpoint: "127.0.0.1:4001" },
        { id: "bad", endpoint: "no-port" },
      ],
      {
        connect,
        onEvent: (e) => events.push(`${e.type}:${e.peerId}`),
      },
    );
    // Concurrent connects → event order is not deterministic.
    expect(events).toEqual(
      expect.arrayContaining(["peer.connected:a", "peer.failed:bad"]),
    );
    expect(events).toHaveLength(2);
    result.closeAll();
    expect(events).toEqual(
      expect.arrayContaining([
        "peer.connected:a",
        "peer.failed:bad",
        "peer.disconnected:a",
      ]),
    );
    expect(events).toHaveLength(3);
  });
});
