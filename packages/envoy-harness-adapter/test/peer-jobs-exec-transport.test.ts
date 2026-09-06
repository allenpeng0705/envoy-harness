/**
 * R5.4 — adapter peer job/exec transport factories (hermetic).
 */

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createLocalExecWorld,
  createLocalJobRegistry,
  createPeerExecWorld,
  formatRemoteJobRef,
  type JobHooks,
  type JobOutcome,
} from "@envoymesh/envoy-harness";
import {
  createInProcessPeerPair,
  createPeerServerHandler,
  PeerRegistry,
} from "@envoymesh/envoy-harness-peer";

import {
  createPeerRemoteExecTransportFromRegistry,
  createPeerRemoteJobTransportFromRegistry,
} from "../src/index.js";
import type { AgentAdapter } from "@envoymesh/agent-adapter";

function stubAdapter(): AgentAdapter {
  return {
    runtime: "envoy-harness",
    describeSkills: () => [],
    buildManifest: async () => ({}) as never,
    execute: async () => ({}) as never,
    verify: async () => [],
  };
}

function controllableJob(output = "x"): {
  hooks: JobHooks;
  settle: (o: JobOutcome) => void;
} {
  let resolveDone!: (o: JobOutcome) => void;
  const done = new Promise<JobOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let buf = output;
  return {
    settle: (o) => resolveDone(o),
    hooks: {
      cancel() {},
      done,
      readOutput() {
        const t = buf;
        buf = "";
        return t;
      },
    },
  };
}

describe("R5.4 adapter peer transports", () => {
  it("routes jobs via PeerRegistry", async () => {
    const registry = createLocalJobRegistry();
    const c = controllableJob("hi");
    const jobId = registry.start({
      kind: "bash",
      label: "t",
      run: () => c.hooks,
    });
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter(),
        identity: { peerId: "p1" },
        jobRegistry: registry,
      }),
    );
    const peers = new PeerRegistry();
    peers.register({
      id: "p1",
      client: pair.client,
    });
    const transport = createPeerRemoteJobTransportFromRegistry(peers);
    const snap = await transport.fetchJob(
      formatRemoteJobRef("p1", jobId),
      new AbortController().signal,
    );
    expect(snap.id).toBe(jobId);
    c.settle({ status: "completed" });
    pair.close();
  });

  it("routes exec via PeerRegistry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "adapter-exec-"));
    try {
      const file = path.join(dir, "a.txt");
      await fs.writeFile(file, "z", "utf8");
      const pair = createInProcessPeerPair(
        createPeerServerHandler({
          adapter: stubAdapter(),
          identity: { peerId: "p2" },
          execWorld: createLocalExecWorld(),
        }),
      );
      const peers = new PeerRegistry();
      peers.register({
        id: "p2",
        client: pair.client,
      });
      const world = createPeerExecWorld({
        peerId: "p2",
        transport: createPeerRemoteExecTransportFromRegistry(peers),
      });
      const read = await world.readFile(file, {}, new AbortController().signal);
      expect(read.content).toBe("z");
      pair.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
