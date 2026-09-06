/**
 * R4.16 — external ACP/Codex/Claude workers via provider registry.
 */

import { describe, expect, it } from "vitest";

import {
  createExternalAgentWorker,
  FakeExternalWorkerTransport,
  registerExternalWorker,
  SubagentProviderRegistry,
  type SubagentInput,
} from "../src/index.js";

const base: SubagentInput = {
  objective: "summarize the diff",
  capabilityTag: "codex",
  costCeilingUsd: 1,
  deadlineMs: 10_000,
};

describe("R4.16 external workers", () => {
  it("registers acp/codex/claude workers on one MeshSubmitter surface", async () => {
    const registry = new SubagentProviderRegistry({
      defaultProviderId: "local",
    });
    registry.register({
      id: "local",
      kind: "local",
      submitter: {
        async submit() {
          return {
            status: "completed",
            content: [{ type: "text", text: "local" }],
            workerPeerId: "local",
            workerRuntime: "envoy-harness",
            costUsd: 0,
            durationMs: 1,
            verdict: { kind: "pass", score: 1, confidence: "high" },
            signature: "",
          };
        },
      },
    });

    registerExternalWorker(
      registry,
      createExternalAgentWorker({
        id: "acp:codex",
        kind: "codex",
        transport: new FakeExternalWorkerTransport(
          (objective) => ({ text: `codex:${objective}`, costUsd: 0.02 }),
        ),
        capabilityTags: ["codex"],
      }),
    );
    registerExternalWorker(
      registry,
      createExternalAgentWorker({
        id: "acp:claude",
        kind: "claude",
        transport: new FakeExternalWorkerTransport("claude-ok"),
        capabilityTags: ["claude"],
      }),
    );

    const signal = new AbortController().signal;
    const viaCodex = await registry.submit(base, signal);
    expect(viaCodex.workerPeerId).toBe("acp:codex");
    expect(viaCodex.content[0]).toMatchObject({
      type: "text",
      text: "codex:summarize the diff",
    });
    expect(viaCodex.costUsd).toBe(0.02);

    const viaClaude = await registry.submit(
      { ...base, capabilityTag: "claude" },
      signal,
    );
    expect(viaClaude.workerPeerId).toBe("acp:claude");
    expect(viaClaude.content[0]).toMatchObject({ text: "claude-ok" });

    const viaLocal = await registry.submit(
      { ...base, capabilityTag: "research" },
      signal,
    );
    expect(viaLocal.workerPeerId).toBe("local");

    const explicit = await registry.submit(
      { ...base, preferredProviderId: "acp:claude" },
      signal,
    );
    expect(explicit.workerPeerId).toBe("acp:claude");
  });

  it("maps transport failures to failed SubagentResult", async () => {
    const registry = new SubagentProviderRegistry();
    registerExternalWorker(
      registry,
      createExternalAgentWorker({
        id: "acp:fail",
        kind: "acp",
        transport: new FakeExternalWorkerTransport(() => {
          throw new Error("upstream down");
        }),
      }),
    );
    const result = await registry.submit(
      { ...base, preferredProviderId: "acp:fail" },
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(result.verdict).toMatchObject({ kind: "fail", reason: "upstream down" });
  });
});
