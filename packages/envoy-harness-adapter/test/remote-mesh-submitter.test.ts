/**
 * F10.3.2 tests — `RemoteMeshSubmitter` in Package 3.
 *
 * Covers:
 * 1. Happy path: submit returns what the transport returns.
 * 2. The transport receives the input.
 * 3. The transport receives the configured `targetPeerId`.
 * 4. The parent's abort signal is forwarded to the transport.
 * 5. Transport errors propagate to the caller.
 * 6. The submitter implements `MeshSubmitter` (type-level
 *    check via `new RemoteMeshSubmitter(...) as MeshSubmitter`).
 * 7. Two submitters with different `targetPeerId`s route to
 *    different peers.
 * 8. Multiple sequential submits work.
 * 9. Multiple parallel submits work (each transport call is
 *    independent — exercises the F10.2 parallel fan-out path).
 * 10. The `SubagentResult.signature` from the transport is
 *     preserved (the transport's contract: the worker signed
 *     the result; the submitter returns it as-is).
 */

import { describe, expect, it } from "vitest";

import {
  type MeshSubmitter,
  type ModelResponse,
  type SubagentInput,
  type SubagentResult,
} from "@envoymesh/envoy-harness";

import {
  RemoteMeshSubmitter,
  type RemoteSubmitterTransport,
} from "@envoymesh/envoy-harness-adapter";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A scripted transport that records every `send()` call and
 *  returns a pre-configured result (or throws). */
function makeTransport(opts: {
  result?: SubagentResult;
  error?: Error;
  delayMs?: number;
}): {
  transport: RemoteSubmitterTransport;
  calls: Array<{ input: SubagentInput; targetPeerId: string; signal: AbortSignal }>;
} {
  const calls: Array<{ input: SubagentInput; targetPeerId: string; signal: AbortSignal }> = [];
  const transport: RemoteSubmitterTransport = {
    async send(input, targetPeerId, signal) {
      calls.push({ input, targetPeerId, signal });
      if (opts.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      if (opts.error) throw opts.error;
      return opts.result ?? defaultResult();
    },
  };
  return { transport, calls };
}

function defaultResult(): SubagentResult {
  return {
    status: "completed",
    content: [{ type: "text", text: "remote-done" }] as ReadonlyArray<ModelResponse["content"][number]>,
    workerPeerId: "remote-w1",
    workerRuntime: "envoy-harness",
    costUsd: 0.001,
    durationMs: 50,
    verdict: { kind: "pass", score: 0.5, confidence: "medium" },
    signature: "remote-sig-abc",
  };
}

function makeInput(): SubagentInput {
  return {
    objective: "do remote work",
    capabilityTag: "code-search",
    costCeilingUsd: 0.1,
    deadlineMs: 1000,
  };
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("F10.3.2: RemoteMeshSubmitter", () => {
  it("submit returns what the transport returns", async () => {
    const expected = defaultResult();
    const { transport } = makeTransport({ result: expected });
    const submitter = new RemoteMeshSubmitter({
      transport,
      targetPeerId: "remote-w1",
    });
    const result = await submitter.submit(makeInput(), new AbortController().signal);
    expect(result).toEqual(expected);
  });

  // -----------------------------------------------------------------------
  // 2. Transport receives the input
  // -----------------------------------------------------------------------

  it("transport receives the input unchanged", async () => {
    const { transport, calls } = makeTransport({});
    const submitter = new RemoteMeshSubmitter({
      transport,
      targetPeerId: "remote-w1",
    });
    const input = makeInput();
    await submitter.submit(input, new AbortController().signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual(input);
  });

  // -----------------------------------------------------------------------
  // 3. Transport receives the configured targetPeerId
  // -----------------------------------------------------------------------

  it("transport receives the configured targetPeerId", async () => {
    const { transport, calls } = makeTransport({});
    const submitter = new RemoteMeshSubmitter({
      transport,
      targetPeerId: "remote-w1",
    });
    await submitter.submit(makeInput(), new AbortController().signal);
    expect(calls[0]?.targetPeerId).toBe("remote-w1");
  });

  // -----------------------------------------------------------------------
  // 4. Abort signal is forwarded to the transport
  // -----------------------------------------------------------------------

  it("parent's abort signal is forwarded to the transport", async () => {
    const { transport, calls } = makeTransport({});
    const submitter = new RemoteMeshSubmitter({
      transport,
      targetPeerId: "remote-w1",
    });
    const controller = new AbortController();
    await submitter.submit(makeInput(), controller.signal);
    // The transport received the SAME signal instance.
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(calls[0]?.signal.aborted).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 5. Transport errors propagate
  // -----------------------------------------------------------------------

  it("transport errors propagate to the caller", async () => {
    const boom = new Error("network: peer unreachable");
    const { transport } = makeTransport({ error: boom });
    const submitter = new RemoteMeshSubmitter({
      transport,
      targetPeerId: "remote-w1",
    });
    await expect(
      submitter.submit(makeInput(), new AbortController().signal),
    ).rejects.toThrow("network: peer unreachable");
  });

  // -----------------------------------------------------------------------
  // 6. Implements MeshSubmitter
  // -----------------------------------------------------------------------

  it("implements MeshSubmitter (can be used as the parent's meshSubmitter)", async () => {
    const { transport } = makeTransport({});
    // This is a type-level test: a RemoteMeshSubmitter is
    // assignable to MeshSubmitter. If the implements clause
    // breaks, this assignment fails to compile.
    const submitter: MeshSubmitter = new RemoteMeshSubmitter({
      transport,
      targetPeerId: "remote-w1",
    });
    expect(typeof submitter.submit).toBe("function");
  });

  // -----------------------------------------------------------------------
  // 7. Different targetPeerIds route to different peers
  // -----------------------------------------------------------------------

  it("two submitters with different targetPeerIds route to different peers", async () => {
    const { transport: t1, calls: c1 } = makeTransport({});
    const { transport: t2, calls: c2 } = makeTransport({});
    const s1 = new RemoteMeshSubmitter({ transport: t1, targetPeerId: "peer-A" });
    const s2 = new RemoteMeshSubmitter({ transport: t2, targetPeerId: "peer-B" });
    await s1.submit(makeInput(), new AbortController().signal);
    await s2.submit(makeInput(), new AbortController().signal);
    expect(c1[0]?.targetPeerId).toBe("peer-A");
    expect(c2[0]?.targetPeerId).toBe("peer-B");
  });

  // -----------------------------------------------------------------------
  // 8. Multiple sequential submits work
  // -----------------------------------------------------------------------

  it("multiple sequential submits all complete", async () => {
    const { transport, calls } = makeTransport({});
    const submitter = new RemoteMeshSubmitter({
      transport,
      targetPeerId: "remote-w1",
    });
    for (let i = 0; i < 3; i++) {
      await submitter.submit(makeInput(), new AbortController().signal);
    }
    expect(calls).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // 9. Multiple parallel submits work (F10.2 fan-out)
  // -----------------------------------------------------------------------

  it("multiple parallel submits all complete (F10.2 fan-out path)", async () => {
    // The transport delays 20ms; 5 parallel submits should
    // overlap (each starts before the previous ends).
    const { transport, calls } = makeTransport({ delayMs: 20 });
    const submitter = new RemoteMeshSubmitter({
      transport,
      targetPeerId: "remote-w1",
    });
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        submitter.submit(makeInput(), new AbortController().signal),
      ),
    );
    const elapsed = Date.now() - t0;
    // Sequential would be ~100ms; parallel should be < 50ms.
    expect(elapsed).toBeLessThan(80);
    expect(calls).toHaveLength(5);
  });

  // -----------------------------------------------------------------------
  // 10. The result's signature is preserved (the transport's contract)
  // -----------------------------------------------------------------------

  it("the worker's signature on the result is preserved (the transport's contract)", async () => {
    const expected: SubagentResult = {
      status: "completed",
      content: [{ type: "text", text: "done" }] as ReadonlyArray<ModelResponse["content"][number]>,
      workerPeerId: "remote-w1",
      workerRuntime: "envoy-harness",
      costUsd: 0.001,
      durationMs: 50,
      verdict: { kind: "pass", score: 0.5, confidence: "medium" },
      signature: "ed25519:REAL-SIGNATURE-FROM-WORKER",
    };
    const { transport } = makeTransport({ result: expected });
    const submitter = new RemoteMeshSubmitter({
      transport,
      targetPeerId: "remote-w1",
    });
    const result = await submitter.submit(makeInput(), new AbortController().signal);
    expect(result.signature).toBe("ed25519:REAL-SIGNATURE-FROM-WORKER");
    // The submitter did NOT modify the result — it just
    // returned what the transport gave. (The transport
    // already verified; the submitter is a thin wrapper.)
    expect(result).toEqual(expected);
  });
});
