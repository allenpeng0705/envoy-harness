/**
 * D2 — loopback TCP: the peer dialect over a real local socket
 * (127.0.0.1, ephemeral port) — no external network.
 */

import { createServer, connect, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonRpcConnection,
} from "@envoymesh/envoy-harness";

import {
  connectPeerClient,
  PeerClient,
  createPeerServerHandler,
} from "../src/index.js";
import { signedResult, stubAdapter } from "./helpers.js";

// Some sandboxed environments refuse to bind even 127.0.0.1 (EPERM).
// Probe once at module load; when binding is impossible, skip the suite
// (CI and normal dev machines run it for real).
let canBindLocalhost = true;
try {
  const probe: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  probe.close();
} catch {
  canBindLocalhost = false;
}

describe.skipIf(!canBindLocalhost)("peer dialect over loopback TCP", () => {
  let sockets: Socket[] = [];
  afterEach(() => {
    for (const s of sockets) s.destroy();
    sockets = [];
  });

  it("pings and submits over a real local socket", async () => {
    const server = createServer((socket) => {
      sockets.push(socket);
      new JsonRpcConnection({
        input: socket,
        output: socket,
        onRequest: createPeerServerHandler({
          adapter: stubAdapter(),
          identity: { peerId: "tcp-peer", model: "deepseek-chat" },
        }),
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const socket = connect(address.port, "127.0.0.1");
    sockets.push(socket);
    const client = new PeerClient({
      connection: new JsonRpcConnection({ input: socket, output: socket }),
    });

    const ping = await client.ping();
    expect(ping.ok).toBe(true);
    expect(ping.peerId).toBe("tcp-peer");

    const executed = await client.execute({
      skillId: "research",
      objective: "tcp hello",
      inputArtifacts: [],
      costCeilingUsd: 1,
      deadlineMs: 10_000,
      correlationId: "tcp-corr",
      signal: new AbortController().signal,
    });
    const expected = signedResult({ correlationId: "tcp-corr" });
    // Ignore the 1ms-float on `completedAt` (each side stamps its own).
    expect({ ...executed, completedAt: undefined }).toEqual({
      ...expected,
      completedAt: undefined,
    });

    server.close();
  });

  it("connectPeerClient connects and round-trips ping + execute", async () => {
    const server = createServer((socket) => {
      sockets.push(socket);
      new JsonRpcConnection({
        input: socket,
        output: socket,
        onRequest: createPeerServerHandler({
          adapter: stubAdapter(),
          identity: { peerId: "tcp-peer", model: "deepseek-chat" },
        }),
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const { client, close } = await connectPeerClient({
      host: "127.0.0.1",
      port: address.port,
    });
    const ping = await client.ping();
    expect(ping.peerId).toBe("tcp-peer");
    const executed = await client.execute({
      skillId: "research",
      objective: "tcp hello",
      inputArtifacts: [],
      costCeilingUsd: 1,
      deadlineMs: 10_000,
      correlationId: "tcp-corr-2",
      signal: new AbortController().signal,
    });
    expect(executed.correlationId).toBe("tcp-corr-2");
    close();
    server.close();
  });
});
