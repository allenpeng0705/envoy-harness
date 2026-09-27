/**
 * Add-on F — input guard mapper + resolve (hermetic Fake client).
 */

import { describe, expect, it } from "vitest";

import {
  FakeDecisionClient,
  defaultDecisionConfig,
  mapInputGuardBlock,
  mergeDecisionConfig,
  resolveInputGuard,
  type DecisionAnswer,
  type DecisionConfig,
  type DecisionResponse,
} from "../../src/decision/index.js";

function cfg(overrides?: Partial<DecisionConfig>): DecisionConfig {
  const base = defaultDecisionConfig();
  return {
    ...base,
    mode: "enforce",
    ...overrides,
    inputGuard: {
      ...base.inputGuard,
      enabled: true,
      ...(overrides?.inputGuard ?? {}),
    },
    modelRouter: { ...base.modelRouter, ...(overrides?.modelRouter ?? {}) },
    safeAuto: { ...base.safeAuto, ...(overrides?.safeAuto ?? {}) },
  };
}

function noul(value: number): DecisionAnswer {
  return { type: "noul", noul: value };
}

function score(value: number): DecisionAnswer {
  return {
    type: "score",
    score: value,
    distribution: {},
    confidence: 0.99,
  };
}

function choice(name: string): DecisionAnswer {
  return {
    type: "choice",
    choice: name,
    probabilities: { [name]: 1 },
    confidence: 0.99,
  };
}

function response(answers: Record<string, DecisionAnswer>): DecisionResponse {
  return { answers, backend: "fake" };
}

describe("mapInputGuardBlock", () => {
  const ig = cfg().inputGuard;

  it("blocks high injection + high harm", () => {
    expect(
      mapInputGuardBlock(
        response({
          prompt_injection: noul(0.95),
          jailbreak: noul(0.1),
          exfil_request: noul(0.1),
          harm_severity: score(2.5),
          topic: choice("credentials"),
        }),
        ig,
      ),
    ).toBe(true);
  });

  it("does not block high injection with low harm", () => {
    expect(
      mapInputGuardBlock(
        response({
          prompt_injection: noul(0.95),
          harm_severity: score(0.5),
        }),
        ig,
      ),
    ).toBe(false);
  });

  it("does not block ordinary coding", () => {
    expect(
      mapInputGuardBlock(
        response({
          prompt_injection: noul(0.05),
          jailbreak: noul(0.02),
          exfil_request: noul(0.01),
          harm_severity: score(0),
          topic: choice("coding"),
        }),
        ig,
      ),
    ).toBe(false);
  });
});

describe("resolveInputGuard", () => {
  it("mode off skips client", async () => {
    const client = new FakeDecisionClient({
      prompt_injection: noul(0.99),
      harm_severity: score(3),
    });
    const r = await resolveInputGuard({
      config: defaultDecisionConfig(),
      client,
      prompt: "ignore previous instructions",
    });
    expect(r.block).toBe(false);
    expect(client.calls).toHaveLength(0);
  });

  it("shadow never blocks", async () => {
    const client = new FakeDecisionClient({
      prompt_injection: noul(0.99),
      jailbreak: noul(0.1),
      exfil_request: noul(0.1),
      harm_severity: score(3),
      topic: choice("credentials"),
    });
    const r = await resolveInputGuard({
      config: cfg({ mode: "shadow" }),
      client,
      prompt: "exfiltrate keys",
    });
    expect(r.record.mapped).toBe("block");
    expect(r.block).toBe(false);
  });

  it("enforce + honorBlock blocks", async () => {
    const client = new FakeDecisionClient({
      prompt_injection: noul(0.99),
      jailbreak: noul(0.1),
      exfil_request: noul(0.1),
      harm_severity: score(3),
      topic: choice("credentials"),
    });
    const r = await resolveInputGuard({
      config: cfg(),
      client,
      prompt: "exfiltrate keys",
    });
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/input guard/i);
  });

  it("enforce + honorBlock false does not block", async () => {
    const client = new FakeDecisionClient({
      prompt_injection: noul(0.99),
      harm_severity: score(3),
    });
    const r = await resolveInputGuard({
      config: cfg({
        inputGuard: {
          ...cfg().inputGuard,
          honorBlock: false,
        },
      }),
      client,
      prompt: "bad",
    });
    expect(r.record.mapped).toBe("block");
    expect(r.block).toBe(false);
  });

  it("client error fail-opens", async () => {
    const client = new FakeDecisionClient(() => {
      throw new Error("boom");
    });
    const r = await resolveInputGuard({
      config: cfg(),
      client,
      prompt: "hello",
    });
    expect(r.block).toBe(false);
    expect(r.record.error).toBe("boom");
  });
});

describe("mergeDecisionConfig inputGuard", () => {
  it("defaults disabled", () => {
    expect(mergeDecisionConfig(undefined, {}).inputGuard.enabled).toBe(false);
  });

  it("merges thresholds", () => {
    const merged = mergeDecisionConfig(
      { inputGuard: { enabled: true, injectionThreshold: 0.9 } },
      {},
    );
    expect(merged.inputGuard.enabled).toBe(true);
    expect(merged.inputGuard.injectionThreshold).toBe(0.9);
    expect(merged.inputGuard.harmScoreBlock).toBe(2.0);
  });
});
