/**
 * Add-on B — model router mapper + resolve (hermetic Fake client).
 */

import { describe, expect, it } from "vitest";

import {
  FakeDecisionClient,
  UNMATCHED_MODEL_PROFILE_ID,
  defaultDecisionConfig,
  mapModelRouterChoice,
  matchModelRouterProfile,
  mergeDecisionConfig,
  resolveIncumbentProfileId,
  resolveModelRouter,
  type DecisionAnswer,
  type DecisionConfig,
  type DecisionResponse,
} from "../../src/decision/index.js";

const PROFILES = [
  {
    id: "fast",
    provider: "openai",
    model: "gpt-4o-mini",
    description: "cheap",
    toolsOk: false,
  },
  {
    id: "strong",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    description: "default",
  },
] as const;

function cfg(overrides?: Partial<DecisionConfig>): DecisionConfig {
  const base = defaultDecisionConfig();
  return {
    ...base,
    mode: "enforce",
    ...overrides,
    modelRouter: {
      ...base.modelRouter,
      enabled: true,
      defaultProfile: "strong",
      profiles: [...PROFILES],
      ...(overrides?.modelRouter ?? {}),
    },
    inputGuard: { ...base.inputGuard, ...(overrides?.inputGuard ?? {}) },
    safeAuto: { ...base.safeAuto, ...(overrides?.safeAuto ?? {}) },
  };
}

function choice(name: string, confidence = 0.99): DecisionAnswer {
  return {
    type: "choice",
    choice: name,
    probabilities: { [name]: 1 },
    confidence,
  };
}

function score(value: number): DecisionAnswer {
  return {
    type: "score",
    score: value,
    distribution: {},
    confidence: 0.99,
  };
}

function noul(value: number): DecisionAnswer {
  return { type: "noul", noul: value };
}

function response(answers: Record<string, DecisionAnswer>): DecisionResponse {
  return { answers, backend: "fake" };
}

describe("mapModelRouterChoice", () => {
  const mr = cfg().modelRouter;

  it("picks tier choice when confident", () => {
    expect(
      mapModelRouterChoice(
        response({
          tier: choice("fast"),
          difficulty: score(1),
          needs_tools: noul(0.1),
        }),
        mr,
      ),
    ).toBe("fast");
  });

  it("falls back to default on low confidence", () => {
    expect(
      mapModelRouterChoice(
        response({
          tier: choice("fast", 0.2),
          difficulty: score(1),
        }),
        mr,
      ),
    ).toBe("strong");
  });

  it("upgrades cheapest pick when difficulty is hard", () => {
    expect(
      mapModelRouterChoice(
        response({
          tier: choice("fast"),
          difficulty: score(2.8),
        }),
        mr,
      ),
    ).toBe("strong");
  });

  it("upgrades when needs_tools and toolsOk=false", () => {
    expect(
      mapModelRouterChoice(
        response({
          tier: choice("fast"),
          difficulty: score(1),
          needs_tools: noul(0.9),
        }),
        mr,
      ),
    ).toBe("strong");
  });
});

describe("resolveModelRouter", () => {
  it("mode off skips client", async () => {
    const client = new FakeDecisionClient({
      tier: choice("fast"),
      difficulty: score(0),
      needs_tools: noul(0),
    });
    const r = await resolveModelRouter({
      config: defaultDecisionConfig(),
      client,
      prompt: "hello",
      incumbentProfileId: "strong",
    });
    expect(r.applied).toBe(false);
    expect(r.profileId).toBe("strong");
    expect(client.calls).toHaveLength(0);
  });

  it("shadow records choice but keeps incumbent", async () => {
    const client = new FakeDecisionClient({
      tier: choice("fast"),
      difficulty: score(0),
      needs_tools: noul(0),
    });
    const r = await resolveModelRouter({
      config: cfg({ mode: "shadow" }),
      client,
      prompt: "what is 2+2?",
      incumbentProfileId: "strong",
    });
    expect(r.record.chosenProfileId).toBe("fast");
    expect(r.applied).toBe(false);
    expect(r.profileId).toBe("strong");
  });

  it("enforce applies chosen profile", async () => {
    const client = new FakeDecisionClient({
      tier: choice("fast"),
      difficulty: score(0),
      needs_tools: noul(0),
    });
    const r = await resolveModelRouter({
      config: cfg(),
      client,
      prompt: "what is 2+2?",
      incumbentProfileId: "strong",
    });
    expect(r.applied).toBe(true);
    expect(r.profileId).toBe("fast");
    expect(r.profile?.model).toBe("gpt-4o-mini");
  });

  it("enforce error fail-opens to defaultProfile for caller apply", async () => {
    const client = new FakeDecisionClient(() => {
      throw new Error("timeout");
    });
    const r = await resolveModelRouter({
      config: cfg(),
      client,
      prompt: "hello",
      incumbentProfileId: "fast",
    });
    expect(r.profileId).toBe("strong");
    expect(r.applied).toBe(true);
    expect(r.record.error).toBe("timeout");
  });
});

describe("mergeDecisionConfig modelRouter", () => {
  it("merges profiles from file layer", () => {
    const merged = mergeDecisionConfig(
      {
        modelRouter: {
          enabled: true,
          defaultProfile: "strong",
          profiles: [...PROFILES],
        },
      },
      {},
    );
    expect(merged.modelRouter.enabled).toBe(true);
    expect(merged.modelRouter.profiles).toHaveLength(2);
    expect(merged.modelRouter.defaultProfile).toBe("strong");
  });
});

describe("matchModelRouterProfile / resolveIncumbentProfileId", () => {
  const mr = cfg().modelRouter;

  it("matches provider+model exactly", () => {
    expect(
      matchModelRouterProfile(mr, {
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    ).toBe("fast");
  });

  it("returns unmatched sentinel when live adapter is unknown", () => {
    expect(
      resolveIncumbentProfileId(mr, {
        provider: "ollama",
        model: "llama3",
      }),
    ).toBe(UNMATCHED_MODEL_PROFILE_ID);
  });

  it("prefers explicit profile id over hints", () => {
    expect(
      resolveIncumbentProfileId(mr, {
        profileId: "fast",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    ).toBe("fast");
  });

  it("enforce applies when incumbent is unmatched", async () => {
    const client = new FakeDecisionClient({
      tier: choice("strong"),
      difficulty: score(1),
      needs_tools: noul(0),
    });
    const r = await resolveModelRouter({
      config: cfg(),
      client,
      prompt: "refactor this",
      incumbentProfileId: UNMATCHED_MODEL_PROFILE_ID,
    });
    expect(r.applied).toBe(true);
    expect(r.profileId).toBe("strong");
  });
});
