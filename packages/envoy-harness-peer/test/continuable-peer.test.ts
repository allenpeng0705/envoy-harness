/**
 * R4.9b — continuable peer tasks over MAP-over-JSON-RPC.
 */

import { describe, expect, it } from "vitest";

import {
  createInProcessPeerPair,
  createPeerServerHandler,
  PeerContinuableTaskRegistry,
  PeerMeshSubmitter,
} from "../src/index.js";
import { signedResult, stubAdapter } from "./helpers.js";

const baseInput = {
  objective: "do the first thing",
  capabilityTag: "research",
  costCeilingUsd: 1,
  deadlineMs: 30_000,
};

describe("R4.9b continuable peer tasks", () => {
  it("round-trip: send follow-up then close and waitSettle", async () => {
    const objectives: string[] = [];
    const adapter = stubAdapter({
      execute: async (input) => {
        objectives.push(input.objective);
        return signedResult({
          correlationId: input.correlationId,
          content: [{ kind: "text", text: `done:${input.objective}` }],
        });
      },
    });
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter,
        identity: { peerId: "peer-1", model: "demo" },
      }),
    );
    const submitter = new PeerMeshSubmitter({ client: pair.client });
    const handle = submitter.submitContinuable(baseInput);
    expect(handle.status().status).toBe("running");

    await new Promise((r) => setTimeout(r, 30));
    await handle.send("follow up please");
    handle.close();
    const result = await handle.waitSettle({ timeoutMs: 5_000 });
    expect(result.status).toBe("completed");
    expect(objectives).toEqual(["do the first thing", "follow up please"]);
    expect(
      result.content.some(
        (b) => b.type === "text" && b.text.includes("follow up"),
      ),
    ).toBe(true);
    pair.close();
  });

  it("interrupt aborts in-flight execute (control queue drained before wait)", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawAbort = false;
    const adapter = stubAdapter({
      execute: async (input) => {
        await gate;
        if (input.signal.aborted) {
          sawAbort = true;
          throw new Error("aborted");
        }
        return signedResult({ correlationId: input.correlationId });
      },
    });
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter,
        identity: { peerId: "peer-1" },
      }),
    );
    const submitter = new PeerMeshSubmitter({ client: pair.client });
    const handle = submitter.submitContinuable(baseInput);
    await new Promise((r) => setTimeout(r, 30));
    handle.interrupt("stop now");
    const settled = handle.waitSettle({ timeoutMs: 5_000 });
    // waitSettle drains interrupt RPC first; then release so execute sees abort.
    await new Promise((r) => setTimeout(r, 20));
    release?.();
    const result = await settled;
    expect(result.status).toBe("failed");
    expect(sawAbort).toBe(true);
    pair.close();
  });

  it("autoSettleAfterIdle settles without explicit close", async () => {
    const adapter = stubAdapter({
      execute: async (input) =>
        signedResult({
          correlationId: input.correlationId,
          content: [{ kind: "text", text: "one-shot" }],
        }),
    });
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter,
        identity: { peerId: "peer-1" },
      }),
    );
    const submitter = new PeerMeshSubmitter({ client: pair.client });
    const handle = submitter.submitContinuable(baseInput, {
      autoSettleAfterIdle: true,
    });
    const result = await handle.waitSettle({ timeoutMs: 5_000 });
    expect(result.status).toBe("completed");
    pair.close();
  });

  it("correlationId is idempotent on submitContinuable", async () => {
    const adapter = stubAdapter({
      execute: async (input) => {
        await new Promise((r) => setTimeout(r, 40));
        return signedResult({ correlationId: input.correlationId });
      },
    });
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter,
        identity: { peerId: "peer-1" },
      }),
    );
    const first = await pair.client.submitContinuable({
      correlationId: "corr-idem",
      input: {
        skillId: "research",
        objective: "once",
        inputArtifacts: [],
        costCeilingUsd: 1,
        deadlineMs: 10_000,
        correlationId: "corr-idem",
      },
    });
    expect(first.idempotent).toBeUndefined();
    const second = await pair.client.submitContinuable({
      correlationId: "corr-idem",
      input: {
        skillId: "research",
        objective: "again",
        inputArtifacts: [],
        costCeilingUsd: 1,
        deadlineMs: 10_000,
        correlationId: "corr-idem",
      },
    });
    expect(second.idempotent).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    await pair.client.closeTask({ correlationId: "corr-idem" });
    await pair.client.waitTaskSettle({
      correlationId: "corr-idem",
      timeoutMs: 5_000,
    });
    pair.close();
  });

  it("blocking submit() still works unchanged", async () => {
    const adapter = stubAdapter();
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter,
        identity: { peerId: "peer-1" },
      }),
    );
    const submitter = new PeerMeshSubmitter({ client: pair.client });
    const result = await submitter.submit(
      baseInput,
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    pair.close();
  });

  it("GC removes settled tasks after TTL", async () => {
    const adapter = stubAdapter({
      execute: async (input) =>
        signedResult({ correlationId: input.correlationId }),
    });
    const registry = new PeerContinuableTaskRegistry({
      adapter,
      peerId: "peer-1",
      settledTtlMs: 30,
    });
    registry.start({
      correlationId: "corr-gc",
      input: {
        skillId: "research",
        objective: "x",
        inputArtifacts: [],
        costCeilingUsd: 1,
        deadlineMs: 5_000,
        correlationId: "corr-gc",
      },
      autoSettleAfterIdle: true,
    });
    await registry.waitSettle("corr-gc", 5_000);
    expect(registry.size()).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.size()).toBe(0);
  });
});
