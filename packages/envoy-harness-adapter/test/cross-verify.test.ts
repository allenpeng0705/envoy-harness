/**
 * F9.5.1 tests — `CrossVerifyFn` + `defaultCrossVerify`.
 *
 * Covers:
 * 1. `defaultCrossVerify(otherAdapter)` returns a function
 *    that calls `otherAdapter.execute()`.
 * 2. The execute call uses the same skillId, objective,
 *    correlationId.
 * 3. The cross verdicts are the local verifier's verdicts
 *    on the new result.
 * 4. When the other adapter throws, the cross-verify
 *    returns a `disputed` verdict with the error message.
 * 5. The cross-verify's inputArtifacts is `[]` (v0 limit).
 * 6. The cross-verify's costCeilingUsd is `0` (v0 limit).
 * 7. The cross-verify's deadlineMs is 30_000 (v0 limit).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defaultCrossVerify } from "../src/index.js";
import type { BuildAgentFn, SignResultFn } from "../src/index.js";
import { EnvoyHarnessAdapter } from "../src/index.js";
import {
  type ModelAdapter,
  type ModelResponse,
  type Tool,
} from "@envoymesh/envoy-harness";
import { generateEd25519KeyPair, signCanonicalPayload } from "@envoymesh/identity";
import type {
  ExecuteInput,
  VerifyInput,
} from "@envoymesh/agent-adapter";
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

import * as envoyHarness from "@envoymesh/envoy-harness";

function buildAdapter(opts: {
  model: ModelAdapter;
  signResult: SignResultFn;
  workerPeerId: string;
}): EnvoyHarnessAdapter {
  return new EnvoyHarnessAdapter({
    buildAgent: buildAgentWith(opts.model),
    signResult: opts.signResult,
    workerPeerId: opts.workerPeerId,
  });
}

function fakeSign(): SignResultFn {
  const key = generateEd25519KeyPair();
  return (u) => ({ ...u, signature: signCanonicalPayload(u, key.privateKeyPem) });
}

/** Run a real `execute()` to get a real `SignedAgentResult`
 *  (the wire format has required fields the test
 *  fixture must match). */
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
// Tests
// ---------------------------------------------------------------------------

describe("defaultCrossVerify", () => {
  it("returns a function that calls otherAdapter.execute", async () => {
    let called: ExecuteInput | null = null;
    const otherAdapter: EnvoyHarnessAdapter = buildAdapter({
      model: scriptedModel("cross result"),
      signResult: fakeSign(),
      workerPeerId: "other",
    });
    const origExecute = otherAdapter.execute.bind(otherAdapter);
    otherAdapter.execute = async (input: ExecuteInput) => {
      called = input;
      return origExecute(input);
    };
    const cross = defaultCrossVerify(otherAdapter);
    const signed = await realSignedResult(otherAdapter, "do the thing");
    const input: VerifyInput = {
      result: signed,
      objective: "do the thing",
    };
    await cross(input);
    expect(called).not.toBeNull();
    expect(called!.skillId).toBe("code-edit");
    expect(called!.objective).toBe("do the thing");
    expect(called!.correlationId).toBe("corr-1");
  });

  it("returns the local verifier's verdicts on the new result", async () => {
    const otherAdapter: EnvoyHarnessAdapter = buildAdapter({
      model: scriptedModel("this is a real result with some content"),
      signResult: fakeSign(),
      workerPeerId: "other",
    });
    const cross = defaultCrossVerify(otherAdapter);
    const signed = await realSignedResult(otherAdapter, "do the thing");
    const input: VerifyInput = {
      result: signed,
      objective: "do the thing",
    };
    const verdicts = await cross(input);
    expect(Array.isArray(verdicts)).toBe(true);
    expect(verdicts.length).toBeGreaterThan(0);
  });

  it("returns a `disputed` verdict when the other adapter throws", async () => {
    const otherAdapter: EnvoyHarnessAdapter = buildAdapter({
      model: scriptedModel("ok"),
      signResult: fakeSign(),
      workerPeerId: "other",
    });
    // Wrap execute to throw on every call (simulates
    // a transport-level failure that the agent's
    // catch-all can't swallow).
    otherAdapter.execute = async (): Promise<SignedAgentResult> => {
      throw new Error("rate limit");
    };
    const cross = defaultCrossVerify(otherAdapter);
    const signed = await realSignedResult(
      buildAdapter({
        model: scriptedModel("ok"),
        signResult: fakeSign(),
        workerPeerId: "primary",
      }),
      "do the thing",
    );
    const input: VerifyInput = {
      result: signed,
      objective: "do the thing",
    };
    const verdicts = await cross(input);
    expect(verdicts).toHaveLength(1);
    const v = verdicts[0]!;
    expect(v.kind).toBe("disputed");
    if (v.kind === "disputed") {
      expect(v.signals[0]).toMatch(/rate limit/);
    }
  });

  it("passes costCeilingUsd=0 and deadlineMs=30_000 (v0 limits)", async () => {
    let captured: ExecuteInput | null = null;
    const otherAdapter: EnvoyHarnessAdapter = buildAdapter({
      model: scriptedModel("ok"),
      signResult: fakeSign(),
      workerPeerId: "other",
    });
    const origExecute = otherAdapter.execute.bind(otherAdapter);
    otherAdapter.execute = async (input: ExecuteInput) => {
      captured = input;
      return origExecute(input);
    };
    const cross = defaultCrossVerify(otherAdapter);
    const signed = await realSignedResult(otherAdapter, "x");
    await cross({ result: signed, objective: "x" });
    expect(captured!.costCeilingUsd).toBe(0);
    expect(captured!.deadlineMs).toBe(30_000);
    expect(captured!.inputArtifacts).toEqual([]);
  });
});
