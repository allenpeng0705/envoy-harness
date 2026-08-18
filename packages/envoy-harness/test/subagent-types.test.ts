/**
 * F10.1.1 tests — sub-agent types + NoopMeshSubmitter.
 *
 * Covers:
 * 1. `SubagentInput` has the expected fields.
 * 2. `SubagentResult` has the expected fields.
 * 3. `MeshSubmitter` is an interface; both
 *    `NoopMeshSubmitter` and a hand-rolled impl
 *    satisfy the type.
 * 4. `NoopMeshSubmitter.submit` throws the
 *    documented error.
 * 5. `NOOP_MESH_SUBMITTER_ERROR` is a stable string
 *    (tests can assert on it without duplicating
 *    the message).
 * 6. The sub-agent input signal is forwarded
 *    (NoopMeshSubmitter doesn't need to honor it
 *    since it always throws, but the type accepts
 *    a signal).
 */

import { describe, expect, it } from "vitest";

import {
  NOOP_MESH_SUBMITTER_ERROR,
  NoopMeshSubmitter,
  type MeshSubmitter,
  type SubagentInput,
  type SubagentResult,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// 1 + 2. Type shape (compile-time checks; runtime smoke)
// ---------------------------------------------------------------------------

describe("SubagentInput shape", () => {
  it("accepts the documented fields", () => {
    const input: SubagentInput = {
      objective: "find foo",
      capabilityTag: "code-search",
      costCeilingUsd: 0.5,
      deadlineMs: 30_000,
    };
    expect(input.objective).toBe("find foo");
    expect(input.capabilityTag).toBe("code-search");
    expect(input.costCeilingUsd).toBe(0.5);
    expect(input.deadlineMs).toBe(30_000);
  });

  it("accepts optional preferredPeerId and preferredRuntime", () => {
    const input: SubagentInput = {
      objective: "x",
      capabilityTag: "y",
      costCeilingUsd: 1.0,
      deadlineMs: 60_000,
      preferredPeerId: "peer-1",
      preferredRuntime: "envoy-harness",
    };
    expect(input.preferredPeerId).toBe("peer-1");
    expect(input.preferredRuntime).toBe("envoy-harness");
  });
});

describe("SubagentResult shape", () => {
  it("accepts the documented fields", () => {
    const result: SubagentResult = {
      status: "completed",
      content: [{ type: "text", text: "hello" }],
      workerPeerId: "p1",
      workerRuntime: "envoy-harness",
      costUsd: 0.01,
      durationMs: 1000,
      verdict: { kind: "pass", score: 0.95, confidence: "high" },
      signature: "",
    };
    expect(result.status).toBe("completed");
    expect(result.signature).toBe("");
  });

  it("signature is empty for v0 local execution", () => {
    const result: SubagentResult = {
      status: "completed",
      content: [],
      workerPeerId: "p1",
      workerRuntime: "envoy-harness",
      costUsd: 0,
      durationMs: 0,
      verdict: { kind: "pass", score: 1.0, confidence: "high" },
      signature: "",
    };
    expect(result.signature).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. MeshSubmitter is an interface
// ---------------------------------------------------------------------------

describe("MeshSubmitter interface", () => {
  it("NoopMeshSubmitter satisfies MeshSubmitter", () => {
    const s: MeshSubmitter = new NoopMeshSubmitter();
    expect(s).toBeInstanceOf(NoopMeshSubmitter);
  });

  it("a hand-rolled impl satisfies MeshSubmitter", () => {
    const custom: MeshSubmitter = {
      async submit(_input, _signal) {
        return {
          status: "completed",
          content: [],
          workerPeerId: "p1",
          workerRuntime: "envoy-harness",
          costUsd: 0,
          durationMs: 0,
          verdict: { kind: "pass", score: 1.0, confidence: "high" },
          signature: "",
        };
      },
    };
    expect(typeof custom.submit).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. NoopMeshSubmitter behavior
// ---------------------------------------------------------------------------

describe("NoopMeshSubmitter", () => {
  it("throws the documented error on submit", async () => {
    const s = new NoopMeshSubmitter();
    const input: SubagentInput = {
      objective: "x",
      capabilityTag: "y",
      costCeilingUsd: 0.1,
      deadlineMs: 1000,
    };
    await expect(
      s.submit(input, new AbortController().signal),
    ).rejects.toThrow(/no MeshSubmitter is configured/);
  });

  it("throws the exact NOOP_MESH_SUBMITTER_ERROR", async () => {
    const s = new NoopMeshSubmitter();
    await expect(
      s.submit(
        {
          objective: "x",
          capabilityTag: "y",
          costCeilingUsd: 0.1,
          deadlineMs: 1000,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(NOOP_MESH_SUBMITTER_ERROR);
  });

  it("NOOP_MESH_SUBMITTER_ERROR mentions LocalMeshSubmitter (actionable)", () => {
    expect(NOOP_MESH_SUBMITTER_ERROR).toMatch(/LocalMeshSubmitter/);
  });

  it("accepts an aborted signal (still throws — signal is for the real impl)", async () => {
    const s = new NoopMeshSubmitter();
    const ac = new AbortController();
    ac.abort();
    // The NoopMeshSubmitter doesn't honor the signal
    // (it always throws). This is a TYPE-LEVEL check
    // that the signature accepts an AbortSignal.
    const input: SubagentInput = {
      objective: "x",
      capabilityTag: "y",
      costCeilingUsd: 0.1,
      deadlineMs: 1000,
    };
    await expect(s.submit(input, ac.signal)).rejects.toThrow();
  });
});
