/**
 * R5.1 / R5.2 — peer jobs/* and exec/* JSON-RPC (hermetic).
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
  createPeerRemoteExecTransport,
  createPeerRemoteJobTransport,
  createPeerServerHandler,
} from "../src/index.js";
import { stubAdapter } from "./helpers.js";

function controllableJob(output = "hello"): {
  hooks: JobHooks;
  settle: (outcome: JobOutcome) => void;
} {
  let resolveDone!: (o: JobOutcome) => void;
  const done = new Promise<JobOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let buf = output;
  return {
    settle: (o) => resolveDone(o),
    hooks: {
      cancel() {
        /* noop */
      },
      done,
      readOutput() {
        const t = buf;
        buf = "";
        return t;
      },
    },
  };
}

describe("R5.1 peer jobs RPC", () => {
  it("fetch / read / list / kill over JSON-RPC", async () => {
    const registry = createLocalJobRegistry();
    const c = controllableJob("out");
    const jobId = registry.start({
      kind: "bash",
      label: "echo",
      owner: "s1",
      run: () => c.hooks,
    });

    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({}),
        identity: { peerId: "worker-a" },
        jobRegistry: registry,
        jobViewer: "s1",
      }),
    );
    const transport = createPeerRemoteJobTransport({
      peerId: "worker-a",
      client: pair.client,
    });
    const ref = formatRemoteJobRef("worker-a", jobId);
    const signal = new AbortController().signal;

    const snap = await transport.fetchJob(ref, signal);
    expect(snap.id).toBe(jobId);
    expect(snap.status).toBe("running");

    const read = await transport.readOutput(ref, signal);
    expect(read.text).toBe("out");

    const listed = await transport.listJobs("peer://worker-a", signal);
    expect(listed.map((j) => j.id)).toContain(jobId);

    expect(await transport.kill(ref, signal, "test")).toBe("requested");
    c.settle({ status: "killed", detail: "test" });
    await registry.wait(jobId, 1_000, "s1");
    expect((await transport.fetchJob(ref, signal)).status).toBe("killed");
    pair.close();
  });
});

describe("R5.2 peer exec RPC", () => {
  it("read / write / shell over JSON-RPC via createPeerExecWorld", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "peer-exec-"));
    try {
      const filePath = path.join(dir, "note.txt");
      await fs.writeFile(filePath, "hello", "utf8");

      const pair = createInProcessPeerPair(
        createPeerServerHandler({
          adapter: stubAdapter({}),
          identity: { peerId: "worker-b" },
          execWorld: createLocalExecWorld(),
        }),
      );
      const transport = createPeerRemoteExecTransport({
        peerId: "worker-b",
        client: pair.client,
      });
      const world = createPeerExecWorld({
        peerId: "worker-b",
        transport,
      });
      const signal = new AbortController().signal;

      const read = await world.readFile(filePath, {}, signal);
      expect(read.content).toBe("hello");

      await world.writeFile(filePath, "world", {}, signal);
      expect(await fs.readFile(filePath, "utf8")).toBe("world");

      const shell = await world.runShell(
        { command: "echo ok", cwd: dir },
        signal,
      );
      expect(shell.exitCode).toBe(0);
      expect(shell.stdout.trim()).toBe("ok");
      pair.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
