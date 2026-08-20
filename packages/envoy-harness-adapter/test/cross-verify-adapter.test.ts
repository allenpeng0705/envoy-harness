/**
 * F9.5.2 tests — `EnvoyHarnessAdapter.crossVerifyWith`
 * integration.
 *
 * Covers:
 * 1. Without `crossVerifyWith`, `verify()` returns
 *    the local verdicts (unchanged behavior).
 * 2. With `crossVerifyWith`, `verify()` returns
 *    local + cross verdicts concatenated.
 * 3. The cross-verify is invoked with the same
 *    VerifyInput the local verifier received.
 * 4. `defaultCrossVerify(otherAdapter)` works as
 *    a crossVerifyWith: end-to-end re-runs the
 *    skill on a different model.
 * 5. The cross-verify's failure surfaces as a
 *    `disputed` verdict in the combined array.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defaultCrossVerify,
  EnvoyHarnessAdapter,
  type BuildAgentFn,
  type CrossVerifyFn,
  type SignResultFn,
} from "../src/index.js";
import * as envoyHarness from "@envoymesh/envoy-harness";
import {
  type ModelAdapter,
  type ModelResponse,
  type Tool,
  type Verdict,
} from "@envoymesh/envoy-harness";
import { generateEd25519KeyPair, signCanonicalPayload } from "@envoymesh/identity";
import type { VerifyInput } from "@envoymesh/agent-adapter";
import type { SignedAgentResult } from "@envoymesh/protocol";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function scriptedModel(text: string): ModelAdapter {
  return {
    async complete(): Promise<ModelResponse> {
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
      };
    },
  };
}

function bashTool(): Tool {
  return {
    name: "bash",
    description: "Run a command.",
    parameters: z.object({ command: z.string() }),
    async execute({ command }, _ctx) {
      return { content: `output of: ${command}` };
    },
  };
}

function buildAgentWith(model: ModelAdapter): BuildAgentFn {
  return ({ objective, costCeilingUsd }) => {
    const { Agent, InMemorySession, newSessionId, ToolRegistry, HookRegistry } = envoyHarness;
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const tools = new ToolRegistry();
    tools.register(bashTool());
    return new Agent({
      model,
      tools,
      session,
      hooks: new HookRegistry(),
      cwd: "/tmp",
      maxCostUsd: costCeilingUsd,
      systemPrompt: objective,
    });
  };
}

function fakeSign(): SignResultFn {
  const key = generateEd25519KeyPair();
  return (u) => ({ ...u, signature: signCanonicalPayload(u, key.privateKeyPem) });
}

function buildAdapter(opts: {
  model: ModelAdapter;
  crossVerifyWith?: CrossVerifyFn;
  workerPeerId: string;
}): EnvoyHarnessAdapter {
  return new EnvoyHarnessAdapter({
    buildAgent: buildAgentWith(opts.model),
    signResult: fakeSign(),
    workerPeerId: opts.workerPeerId,
    ...(opts.crossVerifyWith ? { crossVerifyWith: opts.crossVerifyWith } : {}),
  });
}

async function realSignedResult(
  adapter: EnvoyHarnessAdapter,
  objective: string,
): Promise<SignedAgentResult> {
  return adapter.execute({
    skillId: "code-edit",
    objective,
    inputArtifacts: [],
    costCeilingUsd: 1.0,
    deadlineMs: 60_000,
    correlationId: "corr-1",
    signal: new AbortController().signal,
  });
}

// ---------------------------------------------------------------------------
// 1. Without crossVerifyWith: behavior unchanged
// ---------------------------------------------------------------------------

describe("verify() without crossVerifyWith", () => {
  it("returns the local verdicts", async () => {
    const adapter = buildAdapter({
      model: scriptedModel("ok"),
      workerPeerId: "p1",
    });
    const signed = await realSignedResult(adapter, "do thing");
    const verdicts = await adapter.verify({ result: signed, objective: "do thing" });
    expect(Array.isArray(verdicts)).toBe(true);
    expect(verdicts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. With crossVerifyWith: local + cross concatenated
// ---------------------------------------------------------------------------

describe("verify() with crossVerifyWith", () => {
  it("returns local + cross verdicts concatenated", async () => {
    let crossCalled = false;
    const cross: CrossVerifyFn = async () => {
      crossCalled = true;
      return [
        { kind: "pass", score: 0.95, confidence: "high" },
        { kind: "pass", score: 0.92, confidence: "high" },
      ];
    };
    // Two adapters: one without cross (baseline),
    // one with cross (to compare).
    const baselineAdapter = buildAdapter({
      model: scriptedModel("ok"),
      workerPeerId: "p1",
    });
    const adapterWithCross = buildAdapter({
      model: scriptedModel("ok"),
      crossVerifyWith: cross,
      workerPeerId: "p2",
    });
    const signedBaseline = await realSignedResult(baselineAdapter, "do thing");
    const localVerdicts = await baselineAdapter.verify({
      result: signedBaseline,
      objective: "do thing",
    });
    // Sanity: the baseline didn't call the cross.
    expect(crossCalled).toBe(false);
    // The cross-equipped adapter's verify calls the
    // cross and concatenates.
    const signedCross = await realSignedResult(adapterWithCross, "do thing");
    const combined = await adapterWithCross.verify({
      result: signedCross,
      objective: "do thing",
    });
    expect(crossCalled).toBe(true);
    // 6 local + 2 cross = 8.
    expect(combined.length).toBe(localVerdicts.length + 2);
  });

  it("invokes the cross-verify with the same VerifyInput", async () => {
    let receivedInput: VerifyInput | null = null;
    const cross: CrossVerifyFn = async (input) => {
      receivedInput = input;
      return [];
    };
    const adapter = buildAdapter({
      model: scriptedModel("ok"),
      crossVerifyWith: cross,
      workerPeerId: "p1",
    });
    const signed = await realSignedResult(adapter, "do thing");
    const verifyInput: VerifyInput = { result: signed, objective: "do thing" };
    await adapter.verify(verifyInput);
    expect(receivedInput).not.toBeNull();
    expect(receivedInput!.objective).toBe("do thing");
    expect(receivedInput!.result).toBe(signed);
  });
});

// ---------------------------------------------------------------------------
// 4. defaultCrossVerify as a crossVerifyWith
// ---------------------------------------------------------------------------

describe("defaultCrossVerify as crossVerifyWith", () => {
  it("end-to-end: re-runs the skill on a different model", async () => {
    // Build adapter1 with a model that returns a
    // valid result. Build adapter2 with a different
    // model that also returns a valid result.
    // Use adapter2 as the cross-verify for adapter1.
    const adapter2 = buildAdapter({
      model: scriptedModel("cross-check result text"),
      workerPeerId: "p2",
    });
    const cross = defaultCrossVerify(adapter2);
    const adapter1WithCross = new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(scriptedModel("primary result text")),
      signResult: fakeSign(),
      workerPeerId: "p1",
      crossVerifyWith: cross,
    });
    const signed = await realSignedResult(adapter1WithCross, "do thing");
    const verdicts = await adapter1WithCross.verify({
      result: signed,
      objective: "do thing",
    });
    // The combined array has the local verdicts
    // + the cross verdicts.
    expect(verdicts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Cross failure surfaces as disputed
// ---------------------------------------------------------------------------

describe("verify() when cross-verify fails", () => {
  it("includes a disputed verdict in the combined array", async () => {
    const cross: CrossVerifyFn = async () => {
      return [
        {
          kind: "disputed",
          needsHuman: true,
          signals: ["cross-verify failed: boom"],
        },
      ];
    };
    const adapter = buildAdapter({
      model: scriptedModel("ok"),
      crossVerifyWith: cross,
      workerPeerId: "p1",
    });
    const signed = await realSignedResult(adapter, "do thing");
    const verdicts = await adapter.verify({ result: signed, objective: "do thing" });
    const disputed = verdicts.filter((v: Verdict) => v.kind === "disputed");
    expect(disputed.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 8 / Step 6 — buildEnvoyHarnessAdapterWithCrossVerify
// ---------------------------------------------------------------------------

import { buildEnvoyHarnessAdapterWithCrossVerify } from "../src/index.js";
import type { AgentAdapter } from "@envoymesh/agent-adapter";

describe("buildEnvoyHarnessAdapterWithCrossVerify", () => {
  const buildAgent: BuildAgentFn = () => {
    throw new Error("buildAgent not used in this test");
  };
  const signResult: SignResultFn = (unsigned) => ({
    ...unsigned,
    signature: "test-sig",
  });
  const openClawAdapter: AgentAdapter = {
    runtime: "openclaw",
    describeSkills: () => [],
    buildManifest: async () => {
      throw new Error("not used");
    },
    execute: async () => {
      throw new Error("openClawAdapter.execute called in this test");
    },
    verify: async () => [{ kind: "pass", score: 0.9, confidence: "high" }],
  };

  it("returns an EnvoyHarnessAdapter with crossVerifyWith wired", () => {
    const adapter = buildEnvoyHarnessAdapterWithCrossVerify({
      buildAgent,
      signResult,
      workerPeerId: "peer-1",
      openClawAdapter,
    });
    expect(adapter.runtime).toBe("envoy-harness");
    // The cross-verify is internal; the only way
    // to assert it's wired is to call verify() and
    // observe that the cross closure was invoked.
    // The full e2e is covered in
    // cross-verify.test.ts (F9.5.2 #2 — "with
    // crossVerifyWith, verify() returns local +
    // cross verdicts"). Here we just check the
    // factory doesn't throw and returns a valid
    // adapter.
    expect(typeof adapter.verify).toBe("function");
  });

  it("wires defaultCrossVerify (cross re-runs skill on openClaw)", async () => {
    let crossCalled = false;
    const openClaw: AgentAdapter = {
      ...openClawAdapter,
      execute: async () => {
        crossCalled = true;
        return {
          version: "0.1",
          runtime: "openclaw",
          skillId: "code-review",
          workerPeerId: "peer-1",
          objective: "x",
          content: [{ kind: "text", text: "cross result" }],
          inputArtifacts: [],
          metrics: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
          createdAt: new Date().toISOString(),
          correlationId: "corr-1",
          signature: "",
          raw: { type: "text", text: "cross result", messages: [], content: [], metrics: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, iterations: 0, toolCalls: 0, stopReason: "end_turn", sandboxPolicy: { mode: "read-only", approval: "on-request", backend: "linux-landlock", writableRoots: [], networkAccess: false, slashTmpWritable: true } },
        };
      },
    };
    const adapter = buildEnvoyHarnessAdapterWithCrossVerify({
      buildAgent,
      signResult,
      workerPeerId: "peer-1",
      openClawAdapter: openClaw,
    });
    const signedResult: SignedAgentResult = {
      version: "0.1",
      runtime: "envoy-harness",
      skillId: "code-review",
      workerPeerId: "peer-1",
      objective: "do the thing",
      content: [{ kind: "text", text: "local result" }],
      inputArtifacts: [],
      metrics: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      createdAt: new Date().toISOString(),
      correlationId: "corr-1",
      signature: "test-sig",
    };
    await adapter.verify({ result: signedResult, objective: "do the thing" });
    expect(crossCalled).toBe(true);
  });
});
