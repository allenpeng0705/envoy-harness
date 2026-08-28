/**
 * Hermetic cluster rail — in-process TUI + fake peer server.
 */

import { createServer, type Server } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { createDemoAdapter, startPeerServer } from "@envoymesh/envoy-harness-peer";

import { wireClusterBackend } from "../src/cluster-wiring.js";
import { createInProcessTui } from "../src/in-process.js";
import { buildRailLine } from "../src/screen.js";

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

describe.skipIf(!canBind)("cluster rail integration", () => {
  it("renders a live peer on the cluster rail", async () => {
    const started = await startPeerServer({
      adapter: createDemoAdapter({
        peerId: "p-rail",
        model: "deepseek-chat",
      }),
      identity: { peerId: "p-rail", model: "deepseek-chat" },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const wired = await wireClusterBackend({
        peers: [
          {
            id: "p-rail",
            endpoint: `127.0.0.1:${started.port}`,
            model: "deepseek-chat",
          },
        ],
      });
      const tui = createInProcessTui({ backend: wired.backend });
      try {
        await tui.session.start();
        const cluster = await tui.session.refreshCluster();
        expect(cluster?.connected).toBe(1);
        expect(cluster?.peers.some((p) => p.id === "p-rail")).toBe(true);

        const rail = buildRailLine(
          cluster?.peers.map((p) => ({
            id: p.id,
            ...(p.model !== undefined ? { model: p.model } : {}),
            health: {
              ok: p.health.ok,
              ...(p.health.rttMs !== undefined ? { rttMs: p.health.rttMs } : {}),
            },
          })),
        );
        expect(rail).toContain("p-rail");
        expect(rail).toContain("deepseek-chat");
      } finally {
        tui.close();
        await wired.dispose();
      }
    } finally {
      await started.close();
    }
  });

  it("connects a peer at runtime via /mesh connect", async () => {
    const started = await startPeerServer({
      adapter: createDemoAdapter({ peerId: "p-live", model: "demo" }),
      identity: { peerId: "p-live", model: "demo" },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const wired = await wireClusterBackend({
        peers: [],
        enableRuntimeConnect: true,
      });
      const tui = createInProcessTui({ backend: wired.backend });
      try {
        await tui.session.start();
        await tui.session.connectMeshPeer(`p-live@127.0.0.1:${started.port}`);
        const cluster = await tui.session.refreshCluster();
        expect(cluster?.connected).toBe(1);
        expect(cluster?.peers[0]?.id).toBe("p-live");
      } finally {
        tui.close();
        await wired.dispose();
      }
    } finally {
      await started.close();
    }
  });
});
