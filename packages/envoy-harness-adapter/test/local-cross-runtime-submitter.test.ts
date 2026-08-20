/**
 * Phase 8 Step 2 — `LocalCrossRuntimeSubmitter` unit tests.
 *
 * **Acceptance:** the (B) plan's Step 2 acceptance is
 *   "1 unit test that the MeshSubmitter interface is the same
 *    for both [LocalCrossRuntimeSubmitter and RemoteMeshSubmitter]"
 *   + e2e tests for skill delegation A and B.
 *
 * This file covers the unit + type-level guarantee. The e2e
 * tests live in EnvoyMesh (the host's `LocalRuntimeRegistry` is
 * the piece under test there).
 *
 * **Covers:**
 * 1. `preferredRuntime: "envoy-harness"` → inner submitter.
 * 2. `preferredRuntime: undefined` → inner submitter (default).
 * 3. `preferredRuntime: "openclaw"` → bridge's
 *    `submitToOpenClaw`; result has `workerRuntime: "openclaw"`
 *    and the configured `workerPeerId`.
 * 4. Unknown `preferredRuntime` → throw (fail loud, Q1 invariant).
 * 5. Signal is forwarded to the bridge / inner.
 * 6. Bridge errors propagate to the caller.
 * 7. The submitter implements `MeshSubmitter` (type-level
 *    check via `as MeshSubmitter`); `LocalCrossRuntimeSubmitter`
 *    and `RemoteMeshSubmitter` share the same interface
 *    (acceptance criterion #1).
 */

import { describe, expect, it } from "vitest";

import {
  type MeshSubmitter,
  type ModelResponse,
  type SubagentInput,
  type SubagentResult,
} from "@envoymesh/envoy-harness";

import {
  LocalCrossRuntimeSubmitter,
  type LocalRuntimeBridge,
} from "@envoymesh/envoy-harness-adapter";
import { RemoteMeshSubmitter } from "@envoymesh/envoy-harness-adapter";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A scripted bridge that records every `submitToOpenClaw`
 *  call and returns a pre-configured result (or throws). */
function makeBridge(opts: {
  result?: SubagentResult;
  error?: Error;
  delayMs?: number;
}): {
  bridge: LocalRuntimeBridge;
  calls: Array<{ input: SubagentInput; signal: AbortSignal }>;
} {
  const calls: Array<{ input: SubagentInput; signal: AbortSignal }> = [];
  const bridge: LocalRuntimeBridge = {
    async submitToOpenClaw(input, signal) {
      calls.push({ input, signal });
      if (opts.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      if (opts.error) throw opts.error;
      return opts.result ?? defaultOpenClawResult();
    },
  };
  return { bridge, calls };
}

function defaultOpenClawResult(): SubagentResult {
  return {
    status: "completed",
    content: [
      { type: "text", text: "openclaw-done" },
    ] as ReadonlyArray<ModelResponse["content"][number]>,
    workerPeerId: "wrong-peer", // intentional — we expect the
    // submitter to rewrite this to the configured workerPeerId
    workerRuntime: "envoy-harness", // wrong on purpose — submitter
    // rewrites this to "openclaw"
    costUsd: 0.002,
    durationMs: 75,
    verdict: { kind: "pass", score: 0.7, confidence: "high" },
    signature: "",
  };
}

/** A scripted inner submitter (the same-runtime case). */
function makeInner(opts: {
  result?: SubagentResult;
  error?: Error;
}): {
  inner: MeshSubmitter;
  calls: Array<{ input: SubagentInput; signal: AbortSignal }>;
} {
  const calls: Array<{ input: SubagentInput; signal: AbortSignal }> = [];
  const inner: MeshSubmitter = {
    async submit(input, signal) {
      calls.push({ input, signal });
      if (opts.error) throw opts.error;
      return opts.result ?? defaultInnerResult();
    },
  };
  return { inner, calls };
}

function defaultInnerResult(): SubagentResult {
  return {
    status: "completed",
    content: [
      { type: "text", text: "envoy-harness-done" },
    ] as ReadonlyArray<ModelResponse["content"][number]>,
    workerPeerId: "inner-peer",
    workerRuntime: "envoy-harness",
    costUsd: 0.001,
    durationMs: 50,
    verdict: { kind: "pass", score: 0.5, confidence: "medium" },
    signature: "",
  };
}

function makeInput(
  preferredRuntime: SubagentInput["preferredRuntime"],
): SubagentInput {
  // Note: `exactOptionalPropertyTypes: true` rejects
  // `preferredRuntime: undefined`. We only spread the
  // field when it's defined; the runtime "no preferred"
  // case is the object without the key.
  return {
    objective: `submit to ${preferredRuntime ?? "default"}`,
    capabilityTag: "research",
    costCeilingUsd: 1,
    deadlineMs: 5000,
    ...(preferredRuntime !== undefined ? { preferredRuntime } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LocalCrossRuntimeSubmitter (Phase 8 Step 2)", () => {
  const WORKER_PEER_ID = "12D3KooWTest";

  describe("routing", () => {
    it("routes preferredRuntime='envoy-harness' to the inner submitter", async () => {
      const { inner, calls: innerCalls } = makeInner({});
      const { bridge, calls: bridgeCalls } = makeBridge({});

      const submitter = new LocalCrossRuntimeSubmitter({
        bridge,
        inner,
        workerPeerId: WORKER_PEER_ID,
      });

      const result = await submitter.submit(
        makeInput("envoy-harness"),
        new AbortController().signal,
      );

      expect(innerCalls).toHaveLength(1);
      expect(bridgeCalls).toHaveLength(0);
      expect(result.content[0]).toMatchObject({ type: "text", text: "envoy-harness-done" });
    });

    it("routes preferredRuntime=undefined to the inner submitter (default)", async () => {
      const { inner, calls: innerCalls } = makeInner({});
      const { bridge, calls: bridgeCalls } = makeBridge({});

      const submitter = new LocalCrossRuntimeSubmitter({
        bridge,
        inner,
        workerPeerId: WORKER_PEER_ID,
      });

      await submitter.submit(makeInput(undefined), new AbortController().signal);

      expect(innerCalls).toHaveLength(1);
      expect(bridgeCalls).toHaveLength(0);
    });

    it("routes preferredRuntime='openclaw' to the bridge's submitToOpenClaw", async () => {
      const { inner, calls: innerCalls } = makeInner({});
      const { bridge, calls: bridgeCalls } = makeBridge({});

      const submitter = new LocalCrossRuntimeSubmitter({
        bridge,
        inner,
        workerPeerId: WORKER_PEER_ID,
      });

      const result = await submitter.submit(
        makeInput("openclaw"),
        new AbortController().signal,
      );

      expect(bridgeCalls).toHaveLength(1);
      expect(innerCalls).toHaveLength(0);
      // The bridge sees the original input unchanged.
      expect(bridgeCalls[0]?.input).toMatchObject({
        objective: expect.stringContaining("openclaw"),
        preferredRuntime: "openclaw",
      });
      // The result is rewritten: workerRuntime → "openclaw",
      // workerPeerId → this submitter's configured peer.
      expect(result.workerRuntime).toBe("openclaw");
      expect(result.workerPeerId).toBe(WORKER_PEER_ID);
      // Content is passed through.
      expect(result.content[0]).toMatchObject({ type: "text", text: "openclaw-done" });
    });

    it("throws on unknown preferredRuntime (fail loud per Q1)", async () => {
      const { inner } = makeInner({});
      const { bridge } = makeBridge({});

      const submitter = new LocalCrossRuntimeSubmitter({
        bridge,
        inner,
        workerPeerId: WORKER_PEER_ID,
      });

      // Cast to bypass TS: we're testing the runtime check, not
      // the type. (Today the union is just "envoy-harness" |
      // "openclaw" — but the runtime guard is what matters.)
      await expect(
        submitter.submit(
          makeInput("mystery-runtime" as never),
          new AbortController().signal,
        ),
      ).rejects.toThrow(/unsupported preferredRuntime/);
    });
  });

  describe("signal propagation", () => {
    it("forwards the parent's abort signal to the bridge", async () => {
      const { inner } = makeInner({});
      const { bridge, calls } = makeBridge({ delayMs: 50 });

      const submitter = new LocalCrossRuntimeSubmitter({
        bridge,
        inner,
        workerPeerId: WORKER_PEER_ID,
      });

      const controller = new AbortController();
      const promise = submitter.submit(makeInput("openclaw"), controller.signal);
      // Verify the signal passed to the bridge is the SAME
      // reference (not a copy / wrapped signal). This proves
      // the parent's abort propagates to the bridge.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(calls[0]?.signal).toBe(controller.signal);
      controller.abort();
      // The bridge will throw (or return) when aborted; we
      // don't care about the result, just that the signal
      // was the right one.
      await promise.catch(() => undefined);
    });

    it("forwards the parent's abort signal to the inner submitter", async () => {
      const { inner, calls } = makeInner({});
      const { bridge } = makeBridge({});

      const submitter = new LocalCrossRuntimeSubmitter({
        bridge,
        inner,
        workerPeerId: WORKER_PEER_ID,
      });

      const controller = new AbortController();
      const promise = submitter.submit(makeInput(undefined), controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(calls[0]?.signal).toBe(controller.signal);
      controller.abort();
      await promise.catch(() => undefined);
    });
  });

  describe("error propagation", () => {
    it("propagates bridge errors to the caller", async () => {
      const { inner } = makeInner({});
      const { bridge } = makeBridge({ error: new Error("openclaw_unavailable") });

      const submitter = new LocalCrossRuntimeSubmitter({
        bridge,
        inner,
        workerPeerId: WORKER_PEER_ID,
      });

      await expect(
        submitter.submit(makeInput("openclaw"), new AbortController().signal),
      ).rejects.toThrow(/openclaw_unavailable/);
    });

    it("propagates inner errors to the caller", async () => {
      const { inner } = makeInner({ error: new Error("inner_failure") });
      const { bridge } = makeBridge({});

      const submitter = new LocalCrossRuntimeSubmitter({
        bridge,
        inner,
        workerPeerId: WORKER_PEER_ID,
      });

      await expect(
        submitter.submit(makeInput(undefined), new AbortController().signal),
      ).rejects.toThrow(/inner_failure/);
    });
  });

  describe("interface parity (acceptance criterion #1)", () => {
    it("LocalCrossRuntimeSubmitter implements MeshSubmitter", () => {
      const { bridge, calls: _ } = makeBridge({});
      const { inner, calls: __ } = makeInner({});
      // The cast is the test: if the class doesn't satisfy
      // MeshSubmitter's shape, this line fails to compile.
      const submitter: MeshSubmitter = new LocalCrossRuntimeSubmitter({
        bridge,
        inner,
        workerPeerId: WORKER_PEER_ID,
      });
      expect(submitter).toBeInstanceOf(LocalCrossRuntimeSubmitter);
    });

    it("RemoteMeshSubmitter implements MeshSubmitter (same interface)", () => {
      // The acceptance criterion is that BOTH
      // LocalCrossRuntimeSubmitter (this PR) AND
      // RemoteMeshSubmitter (F10.3.2, prior PR) satisfy the
      // same `MeshSubmitter` interface. The cast below is the
      // test. If either class drifts from the interface,
      // this file (or remote-mesh-submitter.test.ts) fails
      // to compile.
      const submitter: MeshSubmitter = new RemoteMeshSubmitter({
        transport: {
          async send() {
            return {
              status: "completed" as const,
              content: [],
              workerPeerId: "remote-w1",
              workerRuntime: "envoy-harness" as const,
              costUsd: 0,
              durationMs: 0,
              verdict: { kind: "pass" as const, score: 0.5, confidence: "medium" as const },
              signature: "x",
            };
          },
        },
        targetPeerId: "remote-w1",
      });
      expect(submitter).toBeInstanceOf(RemoteMeshSubmitter);
    });
  });
});
