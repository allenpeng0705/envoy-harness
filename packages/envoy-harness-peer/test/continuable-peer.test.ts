/**
 * R4.9b — continuable peer tasks over MAP-over-JSON-RPC.
 */

import { describe, expect, it } from "vitest";

import {
  createInProcessPeerPair,
  createPeerServerHandler,
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

  it("interrupt aborts in-flight execute", async () => {
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
    // Let execute park on the gate, then interrupt over the wire before release.
    await new Promise((r) => setTimeout(r, 30));
    handle.interrupt("stop now");
    await new Promise((r) => setTimeout(r, 30));
    release?.();
    const result = await handle.waitSettle({ timeoutMs: 5_000 });
    expect(result.status).toBe("failed");
    expect(sawAbort).toBe(true);
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
    // Drain
    for (let i = 0; i < 50; i++) {
      const st = await pair.client.taskStatus({ correlationId: "corr-idem" });
      if (st.settled) break;
      await new Promise((r) => setTimeout(r, 20));
    }
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
});
