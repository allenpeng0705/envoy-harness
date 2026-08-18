/**
 * F8.x integration test — adapter in the runtime registry.
 *
 * The adapter's home is `EnvoyHarnessAdapter`; the
 * orchestrator's home is `AdapterRegistry` (in
 * `@envoymesh/agent-adapter`). The integration: register
 * the adapter, look it up by runtime, invoke `execute()`.
 *
 * **Why this is an F8 (not F9) test:** the adapter is
 * already wired to the MAP contract; this just proves
 * the cross-package boundary works. The EnvoyMesh
 * orchestrator (in the EnvoyMesh monorepo) is the
 * side that uses the registry to find the adapter;
 * this test is the symmetric check on the
 * envoy-harness side.
 *
 * **What this catches:** future changes to the
 * `AgentAdapter` interface that break the
 * `EnvoyHarnessAdapter` class. If the contract
 * drifts, this test fails on the registry side
 * (the registry's `register()` would reject the
 * adapter, or the adapter's `execute()` signature
 * would no longer satisfy the interface).
 *
 * **Why direct harness imports:** the integration
 * test mirrors the orchestrator's view (it calls
 * the registry + adapter), but the `buildAgent`
 * factory needs a real `Agent` to wire through.
 * The contract being tested is the *adapter ↔
 * registry* boundary, not the *adapter ↔ harness*
 * boundary (that's covered by `adapter.test.ts`).
 * So this test imports the same harness surface
 * that `adapter.test.ts` does.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AdapterRegistry,
  DuplicateAdapterError,
} from "@envoymesh/agent-adapter";
import { generateEd25519KeyPair, signCanonicalPayload, verifyCanonicalPayload } from "@envoymesh/identity";
import type { CapabilityManifest } from "@envoymesh/protocol";
import {
  Agent,
  HookRegistry,
  InMemorySession,
  newSessionId,
  ToolRegistry,
  type ModelAdapter,
  type ModelResponse,
  type Tool,
} from "@envoymesh/envoy-harness";

import {
  EnvoyHarnessAdapter,
  ENVOY_HARNESS_SKILLS,
  type BuildAgentFn,
  type SignResultFn,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scriptedModel(responses: ReadonlyArray<{
  content: ModelResponse["content"];
  stopReason?: ModelResponse["stopReason"];
}>): ModelAdapter {
  let i = 0;
  return {
    async complete(_input) {
      const r = responses[i];
      if (!r) throw new Error(`scriptedModel: script exhausted (call #${i + 1})`);
      i++;
      return {
        content: r.content,
        stopReason: r.stopReason ?? (r.content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn"),
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

// ---------------------------------------------------------------------------
// AdapterRegistry integration
// ---------------------------------------------------------------------------

describe("EnvoyHarnessAdapter in AdapterRegistry", () => {
  it("registers and is retrievable by runtime 'envoy-harness'", () => {
    const registry = new AdapterRegistry();
    const adapter = buildAdapter({
      model: scriptedModel([]),
      signResult: (u) => ({ ...u, signature: "fake" }),
      workerPeerId: "peer-1",
    });
    registry.register(adapter);
    const got = registry.get("envoy-harness");
    expect(got).toBe(adapter);
  });

  it("rejects a second adapter with the same runtime", () => {
    const registry = new AdapterRegistry();
    const a1 = buildAdapter({
      model: scriptedModel([]),
      signResult: (u) => ({ ...u, signature: "1" }),
      workerPeerId: "peer-1",
    });
    const a2 = buildAdapter({
      model: scriptedModel([]),
      signResult: (u) => ({ ...u, signature: "2" }),
      workerPeerId: "peer-1",
    });
    registry.register(a1);
    expect(() => registry.register(a2)).toThrow(DuplicateAdapterError);
  });

  it("the registered adapter's runtime is 'envoy-harness'", () => {
    const adapter = buildAdapter({
      model: scriptedModel([]),
      signResult: (u) => ({ ...u, signature: "fake" }),
      workerPeerId: "peer-1",
    });
    expect(adapter.runtime).toBe("envoy-harness");
    // The runtime string matches one of the documented
    // AgentRuntimeSchema values.
    expect(["envoy-harness", "openclaw", "pi", "hermes", "codex", "codex-cli", "openhuman"]).toContain(adapter.runtime);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the registry
// ---------------------------------------------------------------------------

describe("end-to-end via registry", () => {
  it("orchestrator pattern: registry.get → adapter.execute → signed result with valid Ed25519", async () => {
    const registry = new AdapterRegistry();
    const key = generateEd25519KeyPair();
    const signResult: SignResultFn = (u) => ({
      ...u,
      signature: signCanonicalPayload(u, key.privateKeyPem),
    });
    const adapter = buildAdapter({
      model: scriptedModel([{ content: [{ type: "text", text: "hello" }] }]),
      signResult,
      workerPeerId: "peer-1",
    });
    registry.register(adapter);

    // 1. Orchestrator looks up the adapter by runtime.
    const got = registry.get("envoy-harness");
    expect(got).toBe(adapter);

    // 2. Orchestrator calls execute() with a mandate.
    const signed = await got!.execute({
      skillId: "code-edit",
      objective: "do the thing",
      inputArtifacts: [],
      costCeilingUsd: 1.0,
      deadlineMs: 60_000,
      correlationId: "corr-1",
      signal: new AbortController().signal,
    });

    // 3. The signed result has the expected shape.
    expect(signed.skillId).toBe("code-edit");
    expect(signed.runtime).toBe("envoy-harness");
    expect(signed.peerId).toBe("peer-1");
    expect(signed.correlationId).toBe("corr-1");
    expect(signed.signature.length).toBeGreaterThan(0);

    // 4. The signature is verifiable with the public key.
    const { signature, ...unsigned } = signed;
    const verified = verifyCanonicalPayload(unsigned, signature, key.publicKeyPem);
    expect(verified).toBe(true);

    // 5. The adapter can verify its own result via verify().
    const verdicts = await got!.verify({
      result: signed,
      objective: "do the thing",
    });
    expect(verdicts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The adapter's exported surface satisfies the AgentAdapter contract
// ---------------------------------------------------------------------------

describe("EnvoyHarnessAdapter satisfies AgentAdapter at the type level", () => {
  it("has the 4 AgentAdapter methods", () => {
    const adapter = buildAdapter({
      model: scriptedModel([]),
      signResult: (u) => ({ ...u, signature: "fake" }),
      workerPeerId: "peer-1",
    });
    expect(typeof adapter.describeSkills).toBe("function");
    expect(typeof adapter.buildManifest).toBe("function");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.verify).toBe("function");
  });

  it("describeSkills returns the 5-skill catalog from the local surface", () => {
    const adapter = buildAdapter({
      model: scriptedModel([]),
      signResult: (u) => ({ ...u, signature: "fake" }),
      workerPeerId: "peer-1",
    });
    const skills = adapter.describeSkills();
    expect(skills).toHaveLength(ENVOY_HARNESS_SKILLS.length);
    // The runtime string on the adapter is part of the
    // manifest it builds. The manifest runtime is
    // 'envoy-harness'.
    expect(adapter.runtime).toBe("envoy-harness");
  });

  it("buildManifest returns an unsigned manifest with the adapter's runtime + skills", async () => {
    const adapter = buildAdapter({
      model: scriptedModel([]),
      signResult: (u) => ({ ...u, signature: "fake" }),
      workerPeerId: "peer-1",
    });
    const m: CapabilityManifest = await adapter.buildManifest({
      peerId: "peer-1",
      ownerId: "owner-1",
      reputationBySkill: { "code-edit": 0.9 },
    });
    expect(m.runtime).toBe("envoy-harness");
    expect(m.peerId).toBe("peer-1");
    expect(m.skills).toHaveLength(5);
  });
});
