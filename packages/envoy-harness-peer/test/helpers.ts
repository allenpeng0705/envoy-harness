/** A stub `AgentAdapter` for hermetic peer tests. */

import type { AgentAdapter } from "@envoymesh/agent-adapter";
import type {
  CapabilityManifest,
  SignedAgentResult,
  Verdict,
} from "@envoymesh/protocol";

export function signedResult(overrides: Partial<SignedAgentResult> = {}): SignedAgentResult {
  return {
    skillId: "research",
    runtime: "envoy-harness",
    peerId: "peer-1",
    correlationId: "corr-1",
    content: [{ kind: "text", text: "worker result" }],
    citations: [],
    metrics: { durationMs: 5, costUsd: 0.01 },
    completedAt: new Date().toISOString(),
    signature: "",
    ...overrides,
  };
}

export function stubAdapter(
  overrides: Partial<AgentAdapter> = {},
): AgentAdapter {
  return {
    runtime: "envoy-harness",
    describeSkills: () => [],
    buildManifest: async (input) =>
      ({
        runtime: "envoy-harness",
        peerId: input.peerId,
        ownerId: input.ownerId,
        skills: [],
        reputationBySkill: {},
      }) as unknown as CapabilityManifest,
    execute: async (input) =>
      signedResult({ skillId: input.skillId, correlationId: input.correlationId }),
    verify: async (): Promise<Verdict[]> => [
      { kind: "pass", score: 1, confidence: "high" },
    ],
    ...overrides,
  };
}
