/**
 * R4.15 — subagent provider registry.
 */

import { describe, expect, it } from "vitest";

import {
  SubagentProviderError,
  SubagentProviderRegistry,
  type MeshSubmitter,
  type SubagentInput,
  type SubagentResult,
} from "../src/index.js";

function ok(peer: string): SubagentResult {
  return {
    status: "completed",
    content: [{ type: "text", text: peer }],
    workerPeerId: peer,
    workerRuntime: "envoy-harness",
    costUsd: 0,
    durationMs: 1,
    verdict: { kind: "pass", score: 1, confidence: "high" },
    signature: "",
  };
}

function stamped(id: string): MeshSubmitter {
  return {
    async submit() {
      return ok(id);
    },
  };
}

const base: SubagentInput = {
  objective: "x",
  capabilityTag: "research",
  costCeilingUsd: 1,
  deadlineMs: 10_000,
};

describe("SubagentProviderRegistry", () => {
  it("routes preferredProviderId, preferredPeerId, then default local", async () => {
    const registry = new SubagentProviderRegistry();
    registry.register({
      id: "local",
      kind: "local",
      submitter: stamped("local"),
    });
    registry.register({
      id: "peer:default",
      kind: "peer",
      submitter: stamped("peer"),
    });
    registry.register({
      id: "acp:codex",
      kind: "external",
      submitter: stamped("codex"),
      canHandle: (input) => input.capabilityTag === "codex",
    });

    const signal = new AbortController().signal;
    expect(
      (
        await registry.submit(
          { ...base, preferredProviderId: "acp:codex" },
          signal,
        )
      ).workerPeerId,
    ).toBe("codex");

    expect(
      (
        await registry.submit(
          { ...base, preferredPeerId: "any-peer" },
          signal,
        )
      ).workerPeerId,
    ).toBe("peer");

    expect((await registry.submit(base, signal)).workerPeerId).toBe("local");

    expect(
      (
        await registry.submit(
          { ...base, capabilityTag: "codex" },
          signal,
        )
      ).workerPeerId,
    ).toBe("codex");
  });

  it("throws on missing preferred provider", async () => {
    const registry = new SubagentProviderRegistry();
    registry.register({
      id: "local",
      kind: "local",
      submitter: stamped("local"),
    });
    await expect(
      registry.submit(
        { ...base, preferredProviderId: "missing" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects duplicate ids", () => {
    const registry = new SubagentProviderRegistry();
    registry.register({
      id: "local",
      kind: "local",
      submitter: stamped("local"),
    });
    expect(() =>
      registry.register({
        id: "local",
        kind: "local",
        submitter: stamped("local2"),
      }),
    ).toThrow(SubagentProviderError);
  });
});
