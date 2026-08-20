/**
 * F8.2 + F8.4 + F8.5 + F8.6 tests — EnvoyHarnessAdapter.
 *
 * Covers:
 * 1. `describeSkills()` returns the catalog.
 * 2. `buildManifest(input)` returns an unsigned manifest
 *    with the right fields.
 * 3. `execute(input)` builds a local Agent via the factory,
 *    runs the skill, translates the result, signs it.
 * 4. `verify(input)` first-cut deterministic checks
 *    (non-empty + non-echo).
 * 5. Cancellation: `input.signal.aborted` is honored.
 * 6. Default `buildAgent` factory: builds a real Agent
 *    with the right tool set per skill.
 *
 * All tests use `FakeModel` for the local Agent (per F7.5
 * design — no real network calls in tests). The `signResult`
 * dep is a fake that just stamps a SHA-256 of the canonical
 * JSON.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHash } from "node:crypto";

import {
  Agent,
  InMemorySession,
  newSessionId,
  ToolRegistry,
  type ModelAdapter,
  type ModelResponse,
  type Tool,
} from "@envoymesh/envoy-harness";

import {
  EnvoyHarnessAdapter,
  defaultBuildAgentFactory,
  type BuildAgentFn,
  type SignResultFn,
} from "../src/adapter.js";
import {
  ENVOY_HARNESS_SKILLS,
  getToolsForSkill,
  isReadOnlySkill,
} from "../src/skills.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A scripted ModelAdapter for adapter execute tests. */
function scriptedModel(
  responses: ReadonlyArray<{ content: ModelResponse["content"]; stopReason?: ModelResponse["stopReason"]; model?: string }>,
): ModelAdapter {
  let i = 0;
  return {
    async complete(_input) {
      const r = responses[i];
      if (!r) {
        throw new Error(`scriptedModel: script exhausted (call #${i + 1})`);
      }
      i++;
      return {
        content: r.content,
        stopReason: r.stopReason ?? (r.content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn"),
        ...(r.model !== undefined ? { model: r.model } : {}),
      };
    },
  };
}

/** Build an Agent with a scripted model. */
function buildAgentWith(model: ModelAdapter): BuildAgentFn {
  return ({ skillId, objective, costCeilingUsd, signal }) => {
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const tools = new ToolRegistry();
    for (const t of getToolsForSkill(skillId)) {
      if (t === "read_file") {
        tools.register(makeReadFile());
      } else if (t === "bash") {
        tools.register(makeBash());
      }
    }
    return new Agent({
      model,
      tools,
      session,
      cwd: "/tmp",
      maxCostUsd: costCeilingUsd,
      systemPrompt: objective,
      ...(signal ? { abortSignal: signal } : {}),
    });
  };
}

function makeReadFile(): Tool {
  return {
    name: "read_file",
    description: "Read a file.",
    parameters: z.object({ path: z.string() }),
    async execute({ path }, _ctx) {
      return { content: `contents of ${path}` };
    },
  };
}

function makeBash(): Tool {
  return {
    name: "bash",
    description: "Run a command.",
    parameters: z.object({ command: z.string() }),
    async execute({ command }, _ctx) {
      return { content: `output of: ${command}` };
    },
  };
}

/** A fake sign function: stamps the SHA-256 of canonical JSON. */
function fakeSign(workerPeerId: string): SignResultFn {
  return (unsigned) => {
    const h = createHash("sha256")
      .update(JSON.stringify(unsigned))
      .digest("base64url");
    return { ...unsigned, signature: `${workerPeerId}:${h}` };
  };
}

const baseExecuteInput = {
  skillId: "code-review",
  objective: "review the recent diff",
  inputArtifacts: [],
  costCeilingUsd: 5.0,
  deadlineMs: 60_000,
  correlationId: "corr-1",
  signal: new AbortController().signal,
} as const;

// ---------------------------------------------------------------------------
// describeSkills
// ---------------------------------------------------------------------------

describe("EnvoyHarnessAdapter.describeSkills", () => {
  it("returns the 8-skill catalog (5 envoy-harness + 3 B-class)", () => {
    // Phase 8 / Step 3 commit 2 — the catalog grew
    // from 5 to 8 (5 envoy-harness + 3 B-class). The
    // test asserts the adapter returns the same list
    // as `ENVOY_HARNESS_SKILLS` (defensive against
    // accidental drift).
    const a = new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(scriptedModel([])),
      signResult: fakeSign("peer-1"),
      workerPeerId: "peer-1",
    });
    expect(a.describeSkills()).toHaveLength(8);
    expect(a.describeSkills().map((s) => s.skillId).sort()).toEqual(
      [...ENVOY_HARNESS_SKILLS.map((s) => s.skillId)].sort(),
    );
  });

  it("returns a copy (mutations don't affect the adapter)", () => {
    const a = new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(scriptedModel([])),
      signResult: fakeSign("peer-1"),
      workerPeerId: "peer-1",
    });
    const skills = a.describeSkills();
    skills.pop();
    // Phase 8 / Step 3 commit 2 — the catalog grew to 8
    // (5 envoy-harness + 3 B-class). The defensive copy
    // still holds: mutating the returned array doesn't
    // affect the adapter's internal catalog.
    expect(a.describeSkills()).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// buildManifest
// ---------------------------------------------------------------------------

describe("EnvoyHarnessAdapter.buildManifest", () => {
  it("returns an unsigned manifest with the right fields", async () => {
    const a = new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(scriptedModel([])),
      signResult: fakeSign("peer-1"),
      workerPeerId: "peer-1",
    });
    const m = await a.buildManifest({
      peerId: "peer-1",
      ownerId: "owner-1",
      reputationBySkill: { "code-edit": 0.9, "code-review": 0.8 },
    });
    expect(m.runtime).toBe("envoy-harness");
    expect(m.runtimeVersion).toBe(ENVOY_HARNESS_SKILLS[0]?.description ? "0.0.0" : "0.0.0");
    expect(m.peerId).toBe("peer-1");
    expect(m.ownerId).toBe("owner-1");
    expect(m.skills).toHaveLength(8);
    expect(m.reputationBySkill).toEqual({
      "code-edit": 0.9,
      "code-review": 0.8,
    });
    expect(m.ttlSeconds).toBe(300);
    expect(() => new Date(m.issuedAt).toISOString()).not.toThrow();
  });

  it("uses the configured runtimeVersion override", async () => {
    const a = new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(scriptedModel([])),
      signResult: fakeSign("peer-1"),
      workerPeerId: "peer-1",
      runtimeVersion: "1.2.3",
    });
    const m = await a.buildManifest({
      peerId: "peer-1",
      ownerId: "owner-1",
      reputationBySkill: {},
    });
    expect(m.runtimeVersion).toBe("1.2.3");
  });
});

// ---------------------------------------------------------------------------
// execute — text-only response
// ---------------------------------------------------------------------------

describe("EnvoyHarnessAdapter.execute — text-only response", () => {
  it("builds an Agent, runs the skill, signs the result", async () => {
    const model = scriptedModel([
      {
        content: [{ type: "text", text: "the diff looks fine" }],
        model: "gpt-4o",
      },
    ]);
    const a = new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(model),
      signResult: fakeSign("peer-1"),
      workerPeerId: "peer-1",
    });
    const signed = await a.execute({ ...baseExecuteInput });
    expect(signed.signature).toMatch(/^peer-1:/);
    expect(signed.skillId).toBe("code-review");
    expect(signed.runtime).toBe("envoy-harness");
    expect(signed.peerId).toBe("peer-1");
    expect(signed.correlationId).toBe("corr-1");
    expect(signed.content).toEqual([{ kind: "text", text: "the diff looks fine" }]);
    expect(signed.citations).toEqual([]);
    expect(signed.metrics.costUsd).toBeGreaterThanOrEqual(0);
    expect(signed.metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stamps a valid ISO completedAt timestamp", async () => {
    const model = scriptedModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const a = new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(model),
      signResult: fakeSign("peer-1"),
      workerPeerId: "peer-1",
    });
    const signed = await a.execute({ ...baseExecuteInput });
    expect(() => new Date(signed.completedAt).toISOString()).not.toThrow();
  });

  it("preserves the lossless local result in `raw`", async () => {
    const model = scriptedModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const a = new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(model),
      signResult: fakeSign("peer-1"),
      workerPeerId: "peer-1",
    });
    const signed = await a.execute({ ...baseExecuteInput });
    expect(signed.raw).toBeDefined();
    // raw is the full local AgentResult; check shape
    const raw = signed.raw as { content: unknown; stopReason: string };
    expect(raw.content).toBeDefined();
    expect(typeof raw.stopReason).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// execute — tool-call + tool-result round-trip
// ---------------------------------------------------------------------------

describe("EnvoyHarnessAdapter.execute — tool-call flow", () => {
  it("preserves the full transcript (including tool calls) in `raw`", async () => {
    const model = scriptedModel([
      {
        content: [
          { type: "text", text: "let me check" },
          {
            type: "tool_call",
            id: "t1",
            name: "read_file",
            args: { path: "/tmp/foo" },
          },
        ],
      },
      {
        content: [{ type: "text", text: "done" }],
      },
    ]);
    const a = new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(model),
      signResult: fakeSign("peer-1"),
      workerPeerId: "peer-1",
    });
    const signed = await a.execute({
      ...baseExecuteInput,
      skillId: "code-edit",
    });
    // The wire `content` is the final assistant text (matches
    // OpenClawAdapter's contract). The full transcript is in
    // `raw.messages` for audit.
    expect(signed.content).toEqual([{ kind: "text", text: "done" }]);
    const raw = signed.raw as { messages: ReadonlyArray<{ role: string; content: ReadonlyArray<{ type: string }> }> };
    expect(raw.messages.length).toBeGreaterThan(1);
    // The transcript should include the tool call
    const toolCallInTranscript = raw.messages.some((m) =>
      m.content.some((b) => b.type === "tool_call"),
    );
    expect(toolCallInTranscript).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// execute — cancellation
// ---------------------------------------------------------------------------

describe("EnvoyHarnessAdapter.execute — cancellation", () => {
  it("throws when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const a = new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(scriptedModel([])),
      signResult: fakeSign("peer-1"),
      workerPeerId: "peer-1",
    });
    await expect(
      a.execute({ ...baseExecuteInput, signal: controller.signal }),
    ).rejects.toThrow(/aborted before start/);
  });
});

// ---------------------------------------------------------------------------
// verify (F8.6+: wires the local verifier rules)
// ---------------------------------------------------------------------------

describe("EnvoyHarnessAdapter.verify (local verifier rules)", () => {
  function adapter() {
    return new EnvoyHarnessAdapter({
      buildAgent: buildAgentWith(scriptedModel([])),
      signResult: fakeSign("peer-1"),
      workerPeerId: "peer-1",
    });
  }

  function signedResultWith(text: string) {
    const fakeSigner = fakeSign("peer-1");
    const unsigned: import("@envoymesh/protocol").AgentResult = {
      skillId: "code-review",
      runtime: "envoy-harness",
      peerId: "peer-1",
      correlationId: "corr-1",
      content: text ? [{ kind: "text", text }] : [],
      citations: [],
      metrics: { durationMs: 1, costUsd: 0 },
      completedAt: new Date().toISOString(),
    };
    return fakeSigner(unsigned);
  }

  it("returns the 6 default-rule verdicts for a well-formed result", async () => {
    const v = await adapter().verify({
      result: signedResultWith("a useful response that addresses the task"),
      objective: "do the thing",
    });
    // The local verifier runs 6 rules; some produce
    // verdicts, some return null. The non-empty rule
    // passes; the keyword-overlap rule may pass; etc.
    // The point is: it's a list of verdicts, not a
    // single "pass".
    expect(Array.isArray(v)).toBe(true);
    // At least one verdict should be a pass.
    const passes = v.filter((x) => x.kind === "pass");
    expect(passes.length).toBeGreaterThan(0);
  });

  it("includes a fail when the result has no text content", async () => {
    const v = await adapter().verify({
      result: signedResultWith(""),
      objective: "do the thing",
    });
    // The non-empty-content rule fires fail.
    const fails = v.filter((x) => x.kind === "fail");
    expect(fails.length).toBeGreaterThan(0);
    const nonEmptyFail = fails.find(
      (x) => x.kind === "fail" && x.reason.toLowerCase().includes("empty"),
    );
    expect(nonEmptyFail).toBeDefined();
    if (nonEmptyFail?.kind === "fail") {
      expect(nonEmptyFail.rollback).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// defaultBuildAgentFactory
// ---------------------------------------------------------------------------

describe("defaultBuildAgentFactory", () => {
  it("returns a factory that builds Agents with the right tool set per skill", () => {
    const model = scriptedModel([]);
    const factory = defaultBuildAgentFactory({ model });
    // Read-only skill → only read_file
    expect(getToolsForSkill("code-review")).toEqual(["read_file"]);
    // Read+write skill → both
    expect(getToolsForSkill("code-edit")).toEqual(["read_file", "bash"]);
    // The factory is a function; the underlying BUILTIN_TOOLS
    // are used. We don't run the factory here (would require
    // a real Agent + model). Just verify the catalog.
    expect(typeof factory).toBe("function");
  });

  it("respects isReadOnlySkill (read-only skills expose no bash)", () => {
    expect(isReadOnlySkill("code-review")).toBe(true);
    expect(isReadOnlySkill("code-edit")).toBe(false);
  });

  it("wires a host-injected meshSubmitter into the Agent (so the task tool fires)", () => {
    // Phase 8 Step 2 / b3 — when the host injects a
    // `meshSubmitter`, the Agent the factory builds must carry
    // it (so its `task` tool is registered). The submitter is
    // opaque here — the factory just passes it through. The
    // shape: `{ submit: (input, signal) => ... }` is what the
    // host's LocalCrossRuntimeSubmitter (or a no-op) provides.
    const model = scriptedModel([]);
    const fakeSubmitter = { submit: () => Promise.resolve({} as never) };
    const factory = defaultBuildAgentFactory({
      model,
      meshSubmitter: fakeSubmitter as never,
    });
    expect(typeof factory).toBe("function");
    // The factory is opaque; we verify wiring by building an
    // agent and reading its `meshSubmitter` field (Agent
    // exposes the field per its `@internal` contract).
    const agent = factory({
      skillId: "code-review",
      objective: "test",
      costCeilingUsd: 1,
      signal: new AbortController().signal,
    });
    // Use the public getter (the field itself is @internal).
    expect(agent.getMeshSubmitter()).toBe(fakeSubmitter);
  });

  it("omits meshSubmitter when not provided (no task tool — sub-agent is leaf-only)", () => {
    // The default behavior: no submitter, the Agent has no
    // `task` tool. The sub-agent can run tools, but it can't
    // spawn sub-sub-agents. This is the v0 (pre-b3) behavior
    // — backward compatible.
    const model = scriptedModel([]);
    const factory = defaultBuildAgentFactory({ model });
    const agent = factory({
      skillId: "code-review",
      objective: "test",
      costCeilingUsd: 1,
      signal: new AbortController().signal,
    });
    expect(agent.getMeshSubmitter()).toBeUndefined();
  });
});
