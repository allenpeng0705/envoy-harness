/**
 * Safe-auto mapper + resolveSafeAutoAsk (Package 1 decision add-ons).
 */

import { describe, expect, it } from "vitest";

import {
  FakeDecisionClient,
  NullDecisionClient,
  applySafeAutoMode,
  defaultDecisionConfig,
  mapSafeAutoAnswers,
  mergeDecisionConfig,
  patchDecisionConfig,
  redactArgsPreview,
  resolveSafeAutoAsk,
  type DecisionAnswer,
  type DecisionConfig,
  type DecisionResponse,
} from "../../src/decision/index.js";

function enforceCfg(overrides?: Partial<DecisionConfig>): DecisionConfig {
  const base = defaultDecisionConfig();
  return {
    ...base,
    mode: "enforce",
    backend: "null",
    ...overrides,
    safeAuto: { ...base.safeAuto, ...(overrides?.safeAuto ?? {}) },
    modelRouter: { ...base.modelRouter, ...(overrides?.modelRouter ?? {}) },
    inputGuard: { ...base.inputGuard, ...(overrides?.inputGuard ?? {}) },
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

function score(value: number, confidence = 0.99): DecisionAnswer {
  return {
    type: "score",
    score: value,
    distribution: { "0": value <= 0.5 ? 1 : 0, "1": value > 0.5 ? 1 : 0 },
    confidence,
  };
}

function noul(value: number): DecisionAnswer {
  return { type: "noul", noul: value };
}

function response(answers: Record<string, DecisionAnswer>): DecisionResponse {
  return { answers, backend: "fake" };
}

describe("redactArgsPreview", () => {
  it("scrubs common secret keys", () => {
    const out = redactArgsPreview({ api_key: "sk-secret", cmd: "ls" });
    expect(out).toContain("***");
    expect(out).not.toContain("sk-secret");
    expect(out).toContain("ls");
  });

  it("keeps prompt strings unquoted and truncates", () => {
    const out = redactArgsPreview("plain prompt text that is longer", 20);
    expect(out.startsWith("plain")).toBe(true);
    expect(out).not.toMatch(/^"/);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(21); // 20 chars + ellipsis
  });
});

describe("mapSafeAutoAnswers", () => {
  const sa = defaultDecisionConfig().safeAuto;

  it("asks when destructive noul exceeds threshold", () => {
    expect(
      mapSafeAutoAnswers(
        response({
          destructive: noul(0.9),
          action: choice("allow"),
          risk: score(0),
        }),
        sa,
      ),
    ).toBe("ask");
  });

  it("allows low-risk high-confidence allow", () => {
    expect(
      mapSafeAutoAnswers(
        response({
          destructive: noul(0.1),
          action: choice("allow", 0.95),
          risk: score(0.2, 0.9),
        }),
        sa,
      ),
    ).toBe("allow");
  });

  it("asks when action confidence is below min even if risk is confident", () => {
    expect(
      mapSafeAutoAnswers(
        response({
          destructive: noul(0.1),
          action: choice("allow", 0.2),
          risk: score(0.2, 0.99),
        }),
        sa,
      ),
    ).toBe("ask");
  });

  it("maps deny choice to deny", () => {
    expect(
      mapSafeAutoAnswers(
        response({
          action: choice("deny", 0.9),
          risk: score(2, 0.9),
        }),
        sa,
      ),
    ).toBe("deny");
  });
});

describe("applySafeAutoMode", () => {
  it("shadow keeps asking regardless of allow", () => {
    expect(applySafeAutoMode("allow", "shadow", false)).toEqual({
      shouldAsk: true,
      effective: "allow",
    });
  });

  it("enforce allow skips ask", () => {
    expect(applySafeAutoMode("allow", "enforce", false)).toEqual({
      shouldAsk: false,
      effective: "allow",
    });
  });

  it("enforce deny without honorDeny still asks", () => {
    const r = applySafeAutoMode("deny", "enforce", false);
    expect(r.shouldAsk).toBe(true);
    expect(r.effective).toBe("deny");
  });

  it("enforce deny with honorDeny does not ask (caller blocks)", () => {
    expect(applySafeAutoMode("deny", "enforce", true)).toEqual({
      shouldAsk: false,
      effective: "deny",
    });
  });
});

describe("resolveSafeAutoAsk", () => {
  it("mode off returns incumbent without calling client", async () => {
    const client = new FakeDecisionClient({
      action: choice("allow"),
      risk: score(0),
      destructive: noul(0),
    });
    const r = await resolveSafeAutoAsk({
      config: defaultDecisionConfig(),
      client,
      incumbentAsk: true,
      tool: "bash",
    });
    expect(r.shouldAsk).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  it("enforce allow becomes shouldAsk false", async () => {
    const client = new FakeDecisionClient({
      action: choice("allow"),
      risk: score(0),
      destructive: noul(0),
    });
    const r = await resolveSafeAutoAsk({
      config: enforceCfg(),
      client,
      incumbentAsk: true,
      tool: "bash",
    });
    expect(r.shouldAsk).toBe(false);
    expect(r.record.mapped).toBe("allow");
    expect(client.calls).toHaveLength(1);
  });

  it("null client fail-open keeps ask", async () => {
    const r = await resolveSafeAutoAsk({
      config: enforceCfg({ backend: "null" }),
      client: new NullDecisionClient(),
      incumbentAsk: true,
      tool: "bash",
    });
    expect(r.shouldAsk).toBe(true);
  });

  it("skips tools not in safeAuto.tools", async () => {
    const client = new FakeDecisionClient({
      action: choice("allow"),
      risk: score(0),
    });
    const r = await resolveSafeAutoAsk({
      config: enforceCfg(),
      client,
      incumbentAsk: true,
      tool: "read_file",
    });
    expect(r.shouldAsk).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  it("enforce honorDeny sets deny and not shouldAsk", async () => {
    const client = new FakeDecisionClient({
      action: choice("deny", 0.99),
      risk: score(2),
      destructive: noul(0.1),
    });
    const r = await resolveSafeAutoAsk({
      config: enforceCfg({
        safeAuto: {
          ...defaultDecisionConfig().safeAuto,
          honorDeny: true,
        },
      }),
      client,
      incumbentAsk: true,
      tool: "bash",
    });
    expect(r.deny).toBe(true);
    expect(r.shouldAsk).toBe(false);
    expect(r.record.mapped).toBe("deny");
  });

  it("always-confirm autoRun skips safe-auto allow (keeps ask)", async () => {
    const client = new FakeDecisionClient({
      action: choice("allow"),
      risk: score(0),
      destructive: noul(0),
    });
    const r = await resolveSafeAutoAsk({
      config: enforceCfg(),
      client,
      incumbentAsk: true,
      tool: "bash",
      stateExtras: { autoRun: "always-confirm" },
    });
    expect(r.shouldAsk).toBe(true);
    expect(r.deny).toBe(false);
    expect(client.calls).toHaveLength(0);
  });
});

describe("mergeDecisionConfig / patchDecisionConfig", () => {
  it("defaults to off", () => {
    expect(mergeDecisionConfig(undefined, {}).mode).toBe("off");
  });

  it("env overrides file layer", () => {
    const cfg = mergeDecisionConfig(
      { mode: "shadow" },
      { ENVOY_DECISION_MODE: "enforce" } as NodeJS.ProcessEnv,
    );
    expect(cfg.mode).toBe("enforce");
  });

  it("patch ignores process env", () => {
    const current = mergeDecisionConfig({ mode: "shadow" }, {});
    const next = patchDecisionConfig(current, { mode: "enforce" });
    expect(next.mode).toBe("enforce");
  });

  it("partial modelRouter patch keeps profiles", () => {
    const current = mergeDecisionConfig(
      {
        modelRouter: {
          enabled: true,
          profiles: [
            { id: "fast", provider: "openai", model: "gpt-4o-mini" },
            { id: "strong", provider: "anthropic", model: "claude-sonnet-4-6" },
          ],
          defaultProfile: "strong",
        },
      },
      {},
    );
    const next = patchDecisionConfig(current, {
      modelRouter: { enabled: false },
    });
    expect(next.modelRouter.enabled).toBe(false);
    expect(next.modelRouter.profiles).toHaveLength(2);
  });
});
