/**
 * EnvoyHarnessAdapter — the reference `AgentAdapter` for
 * envoy-harness.
 *
 * **Design doc:** `docs/improving-agent-network.en.md` §5.2
 * (in the EnvoyMesh monorepo) + envoy-harness's own design
 * §11. The class is the **only** place that knows about both
 * envoy-harness (Package 1) and the mesh (Package 2 +
 * `@envoymesh/agent-adapter`).
 *
 * **Why dependency injection:** the adapter is
 * runtime-agnostic — it imports no app-level module. The
 * host provides:
 * - `buildAgent(skillId, objective, signal)`: a factory
 *   that produces a fresh `Agent` per `execute()` call.
 *   The agent is constructed with the skill's tool set,
 *   the orchestrator's cost ceiling, and the abort signal.
 *   In tests, the host injects a factory that returns
 *   an Agent with `FakeModel`.
 * - `signResult(unsigned)`: signs the wire `AgentResult`
 *   with the node's owner key. The adapter does NOT
 *   invent or hold a key (per the protocol contract).
 *   The host provides a closure that does the Ed25519
 *   sign over the canonical JSON.
 * - `workerPeerId`: the node's peerId. Stamped into every
 *   result and the manifest.
 *
 * **Skill → tool mapping:** `getToolsForSkill(skillId)`
 * returns the local tool set. The factory is responsible
 * for filtering the global tool registry; the adapter
 * only tells it the skill.
 *
 * **Manifest signing:** the manifest is *unsigned* by
 * the adapter. The orchestrator signs with the owner's
 * key. (See `AgentAdapter.buildManifest` doc: "The
 * adapter is **not** responsible for signing. The owner
 * signs because the manifest advertises the owner's
 * capabilities.")
 *
 * **Result signing:** the result is signed by the node
 * (not the adapter, not the worker). This is the
 * `signResult` closure. The signature is over the
 * canonical JSON of the unsigned wire `AgentResult`
 * (including `raw`, per the protocol doc: "the signature
 * covers it so a malicious adapter cannot retroactively
 * edit it").
 *
 * **Stability:** the public surface is `EnvoyHarnessAdapter`
 * (class) + `EnvoyHarnessAdapterInput` (constructor opts).
 * Additive; new fields don't break existing callers.
 */

import type {
  AgentAdapter,
  BuildManifestInput,
  ExecuteInput,
  VerifyInput,
} from "@envoymesh/agent-adapter";
import type {
  AgentResult as WireAgentResult,
  CapabilityManifest,
  SignedAgentResult,
  Verdict,
} from "@envoymesh/protocol";

import {
  Agent,
  BUILTIN_TOOLS,
  HookRegistry,
  InMemorySession,
  installToolPermissionAskHook,
  newSessionId,
  ToolRegistry,
  type AskHandler,
  type MeshSubmitter,
  type ModelAdapter,
  type Session,
  type Tool,
} from "@envoymesh/envoy-harness";

import { ENVOY_HARNESS_SKILLS, ENVOY_HARNESS_VERSION, getToolsForSkill } from "./skills.js";
import { localToWireResult } from "./translation.js";
import { defaultCrossVerify, runLocalVerifier, type CrossVerifyFn } from "./verify.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Factory that builds a fresh `Agent` per `execute()` call.
 * The factory is the only place that knows how to wire
 * the local harness to the adapter.
 */
export type BuildAgentFn = (input: {
  skillId: string;
  objective: string;
  costCeilingUsd: number;
  signal: AbortSignal;
}) => Agent;

/** Sign an unsigned wire `AgentResult` with the node's owner key. */
export type SignResultFn = (unsigned: WireAgentResult) => SignedAgentResult;

export interface EnvoyHarnessAdapterInput {
  /** Factory that builds a fresh `Agent` per `execute()`. */
  buildAgent: BuildAgentFn;
  /** Sign an unsigned wire `AgentResult`. The node provides the key. */
  signResult: SignResultFn;
  /** The node's agent peerId. Stamped into every result. */
  workerPeerId: string;
  /**
   * Optional: env's runtime version. Default:
   * `ENVOY_HARNESS_VERSION` ("0.0.0").
   */
  runtimeVersion?: string;
  /**
   * Optional: prompt builder. Default: a Team-job-shaped
   * prompt that mirrors the design §11 layout (skill hint
   * + objective + tool set + "produce a useful result").
   */
  buildPrompt?: (input: ExecuteInput) => string;
  /**
   * F9.5: optional cross-verify closure. When set,
   * `verify()` calls it AFTER the local verifier and
   * concatenates the cross verdicts with the local
   * ones. Returns the combined array (per the
   * `AgentAdapter.verify()` contract: `Verdict[]`).
   *
   * The orchestrator collapses the combined array
   * with `combineVerdicts(verdicts)` (envoy-harness's
   * `verifier/index.ts`).
   *
   * **Default factory:** `defaultCrossVerify(otherAdapter)`
   * re-runs the same skill on a different
   * `AgentAdapter` (typically a second
   * `EnvoyHarnessAdapter` with a different
   * `ModelAdapter`) and returns the local
   * verifier's verdicts for the new result.
   */
  crossVerifyWith?: CrossVerifyFn;
}

// ---------------------------------------------------------------------------
// EnvoyHarnessAdapter
// ---------------------------------------------------------------------------

/**
 * The reference `AgentAdapter` for envoy-harness. The
 * adapter is the bridge between the local harness
 * (Package 1) and the mesh (Package 2 +
 * `@envoymesh/agent-adapter`).
 */
export class EnvoyHarnessAdapter implements AgentAdapter {
  readonly runtime = "envoy-harness" as const;

  private readonly buildAgent: BuildAgentFn;
  private readonly signResult: SignResultFn;
  private readonly workerPeerId: string;
  private readonly runtimeVersion: string;
  private readonly buildPrompt: (input: ExecuteInput) => string;
  /** F9.5: optional cross-verify closure. */
  private readonly crossVerifyWith: CrossVerifyFn | undefined;

  constructor(input: EnvoyHarnessAdapterInput) {
    this.buildAgent = input.buildAgent;
    this.signResult = input.signResult;
    this.workerPeerId = input.workerPeerId;
    this.runtimeVersion = input.runtimeVersion ?? ENVOY_HARNESS_VERSION;
    this.buildPrompt = input.buildPrompt ?? defaultEnvoyHarnessPrompt;
    this.crossVerifyWith = input.crossVerifyWith;
  }

  /** The catalog of skills this adapter advertises. */
  describeSkills() {
    return [...ENVOY_HARNESS_SKILLS];
  }

  /**
   * Build an unsigned `CapabilityManifest` for broadcast.
   * The orchestrator signs with the owner's key (not the
   * adapter's). See `AgentAdapter.buildManifest` doc.
   */
  async buildManifest(input: BuildManifestInput): Promise<CapabilityManifest> {
    return {
      runtime: this.runtime,
      runtimeVersion: this.runtimeVersion,
      peerId: input.peerId,
      ownerId: input.ownerId,
      skills: this.describeSkills(),
      reputationBySkill: input.reputationBySkill,
      issuedAt: new Date().toISOString(),
      ttlSeconds: 300,
    };
  }

  /**
   * Run a skill. The adapter builds a local `Agent` via
   * the `buildAgent` factory, runs the skill's objective,
   * translates the result, and signs it.
   *
   * **Cancellation:** `input.signal` is forwarded to the
   * agent. The agent's `abort()` is called when the
   * signal fires. (The harness's agent loop respects the
   * signal at every iteration boundary.)
   *
   * **Cost ceiling:** the orchestrator's
   * `chain-budget-ledger` is the authoritative gate. The
   * adapter passes `costCeilingUsd` to the agent as
   * `maxCostUsd` (F7.5) so the harness aborts when the
   * accumulated cost exceeds the ceiling.
   */
  async execute(input: ExecuteInput): Promise<SignedAgentResult> {
    if (input.signal.aborted) {
      throw new Error("MAP execute aborted before start");
    }
    const startedAt = Date.now();
    // Build the prompt ONCE (v0 called buildPrompt twice, producing
    // two identical strings for the worker).
    const prompt = this.buildPrompt(input);
    const agent = this.buildAgent({
      skillId: input.skillId,
      objective: prompt,
      costCeilingUsd: input.costCeilingUsd,
      signal: input.signal,
    });
    const localResult = await agent.run(prompt);
    if (input.signal.aborted) {
      throw new Error("MAP execute aborted during run");
    }
    const durationMs = Date.now() - startedAt;

    // Build the wire result. `raw` keeps the full local
    // result for audit (the signature covers it).
    const unsigned: WireAgentResult = localToWireResult({
      skillId: input.skillId,
      correlationId: input.correlationId,
      peerId: this.workerPeerId,
      runtime: "envoy-harness",
      content: localResult.content,
      durationMs,
      ...(localResult.metrics.inputTokens !== undefined
        ? { promptTokens: localResult.metrics.inputTokens }
        : {}),
      ...(localResult.metrics.outputTokens !== undefined
        ? { completionTokens: localResult.metrics.outputTokens }
        : {}),
      costUsd: localResult.metrics.costUsd,
      raw: localResult,
    });
    return this.signResult(unsigned);
  }

  /**
   * Runtime-specific verifier. Wires the local verifier
   * rules (F1.4d) to the wire `SignedAgentResult`:
   * decodes the content blocks (text + structured tool
   * calls/results) back to the local shape, runs the
   * 6 default rules, returns the verdicts.
   *
   * **Sandbox policy:** the wire doesn't carry the
   * worker's effective sandbox; `runLocalVerifier`
   * defaults to a safe `read-only` policy (the
   * `sandboxRespectedRule` is a no-op against that).
   * The full lossless local result is in
   * `SignedAgentResult.raw` for audit.
   *
   * **Cross-verify (F9.5):** when `crossVerifyWith` is
   * set, this method ALSO calls the cross-verify
   * closure and concatenates the cross verdicts with
   * the local ones. The orchestrator collapses the
   * combined array with `combineVerdicts(verdicts)`.
   */
  async verify(input: VerifyInput): Promise<Verdict[]> {
    const local = await runLocalVerifier(input);
    if (!this.crossVerifyWith) return local;
    const cross = await this.crossVerifyWith(input);
    return [...local, ...cross];
  }
}

// ---------------------------------------------------------------------------
// Default prompt builder
// ---------------------------------------------------------------------------

/**
 * The default prompt for an envoy-harness MAP execute.
 * Mirrors the design §11 prompt structure (skill hint +
 * objective + input artifacts + tool set + "produce a
 * useful result"). Tests can override via
 * `EnvoyHarnessAdapterInput.buildPrompt`.
 */
function defaultEnvoyHarnessPrompt(input: ExecuteInput): string {
  const tools = getToolsForSkill(input.skillId);
  const toolList = tools.length > 0 ? tools.join(", ") : "(no tools — read-only)";
  const parts = [
    "You are an envoy-harness worker on the EnvoyMesh Agent Network.",
    `Required skill: ${input.skillId}`,
    `Available tools: ${toolList}`,
    `Cost ceiling: $${input.costCeilingUsd.toFixed(2)}`,
    `Deadline: ${Math.ceil(input.deadlineMs / 1000)}s`,
    `Objective:\n${input.objective}`,
  ];
  if (input.inputArtifacts.length > 0) {
    const lines = input.inputArtifacts
      .map((n) => `- ${n.key}: ${describeArtifact(n)}`)
      .join("\n");
    parts.push(`Input artifacts:\n${lines}`);
  }
  parts.push(
    "Produce a clear, useful result for the orchestrator. Be concise and factual.",
  );
  return parts.join("\n\n");
}

function describeArtifact(named: { key: string; artifact: unknown }): string {
  const a = named.artifact;
  if (a && typeof a === "object") {
    const kind = (a as { kind?: unknown }).kind;
    if (kind === "text") {
      const content = (a as { content?: string }).content ?? "";
      return content.length > 2000 ? `${content.slice(0, 2000)}…` : content;
    }
    if (kind === "file") {
      return `path: ${(a as { vaultPath?: string }).vaultPath ?? "?"}`;
    }
    if (kind === "structured") {
      const data = (a as { data?: unknown }).data;
      try {
        const json = JSON.stringify(data);
        return json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
      } catch {
        return "structured (unserializable)";
      }
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Default `buildAgent` factory (for callers that don't want to inject one)
// ---------------------------------------------------------------------------

/**
 * Build a default `buildAgent` factory. The factory:
 * 1. Creates a fresh `Session` per `execute()`.
 * 2. Builds a `ToolRegistry` with the skill's tool subset
 *    from `BUILTIN_TOOLS`.
 * 3. Constructs an `Agent` with the model, registry, and
 *    cost ceiling.
 *
 * The model is taken from the closure's `model` parameter
 * (the same `EnvoyHarnessAdapterInput.model`).
 *
 * **Optional `meshSubmitter`:** when provided, the
 * `Agent` is constructed with a `meshSubmitter` so the
 * sub-agent's `task` tool fires through the host's
 * sub-agent pipeline (typically a
 * `LocalCrossRuntimeSubmitter` + `LocalRuntimeRegistry`
 * for cross-runtime delegation). Default: no submitter →
 * no `task` tool (sub-agents can't spawn sub-sub-agents).
 * The mesh's design invariant #9 ("sub-agents are NEW
 * sessions, even local") still holds — the sub-agent's
 * session is fresh, the parent's session is not shared.
 *
 * **Optional `bClassTools`:** Phase 8 / Step 3 — the
 * 3 B-class skills (sponsor-friend / peer-list /
 * relay-status) are exposed as additional BUILTIN
 * tools. The host (EnvoyMesh's
 * `createRealEnvoyHarnessRuntime`) builds the deps
 * for each tool and passes them in. Per-skill
 * registration: the factory checks each tool's name
 * against the skill's tool set (per
 * `getToolsForSkill`); only matching tools are
 * registered for the current skill.
 *
 * **Why the per-skill filter:** the model sees a
 * different tool set per skill (e.g. `code-review`
 * gets `read_file`; `peer-list` gets `list_peers`).
 * The bClassTools are no exception: when the
 * orchestrator's `requiredSkill` is `code-edit`, the
 * model does NOT see `sponsor_friend`. The
 * registration is per-skill, not per-factory.
 */
export function defaultBuildAgentFactory(opts: {
  model: ModelAdapter;
  cwd?: string;
  /** Phase 8 Step 2 / b3 — sub-agent's `task` tool
   *  routes through this `MeshSubmitter`. Omit to
   *  skip the `task` tool. */
  meshSubmitter?: MeshSubmitter;
  /** Phase 8 / Step 3 — the 3 B-class tools
   *  (sponsor_friend / list_peers / relay_status).
   *  The host builds the deps (mesh / profile /
   *  config / audit) and passes them in. Omit
   *  to disable B-class tools for this agent. */
  bClassTools?: ReadonlyArray<Tool>;
  /**
   * Phase G / 12b — optional live AskHandler (e.g. ACP →
   * pi:proposal). Resolved per Agent construction so the
   * host can swap the bridge between asks.
   */
  getAskHandler?: () => AskHandler | undefined;
  /**
   * When `getAskHandler` is set, PreToolUse asks only when
   * this returns true. Default: ask for every tool.
   */
  shouldAskTool?: (toolName: string) => boolean;
}): BuildAgentFn {
  const cwd = opts.cwd ?? process.cwd();
  return ({ skillId, objective, costCeilingUsd, signal }) => {
    // `objective` is the full prompt (per the adapter's contract);
    // the default factory sends it as the user message via
    // `agent.run` — no system-prompt duplication.
    void objective;
    const session: Session = new InMemorySession(newSessionId(), {
      cwd,
      // code-edit is the write skill; the default executor needs
      // workspace-write for bash to be able to edit files. All
      // other skills stay read-only.
      permissionMode: skillId === "code-edit" ? "workspace-write" : "read-only",
      startedAt: new Date().toISOString(),
    });
    const toolNames = new Set(getToolsForSkill(skillId));
    const tools = new ToolRegistry();
    // Standard BUILTIN tools (read_file, bash, etc.).
    for (const t of BUILTIN_TOOLS) {
      if (toolNames.has(t.name as "read_file" | "bash")) {
        tools.register(t);
      }
    }
    // Phase 8 / Step 3 — B-class tools. The tool's
    // `name` is checked against the skill's tool set;
    // only matching tools are registered. This lets the
    // orchestrator pick `peer-list` and have the model
    // see `list_peers` (not `sponsor_friend`).
    if (opts.bClassTools) {
      for (const t of opts.bClassTools) {
        if (toolNames.has(t.name as "read_file" | "bash" | "sponsor_friend" | "list_peers" | "relay_status")) {
          tools.register(t);
        }
      }
    }
    const hooks = new HookRegistry();
    const askHandler = opts.getAskHandler?.();
    if (askHandler !== undefined) {
      installToolPermissionAskHook(hooks, {
        ...(opts.shouldAskTool !== undefined
          ? { shouldAsk: opts.shouldAskTool }
          : {}),
      });
    }
    return new Agent({
      model: opts.model,
      tools,
      session,
      hooks,
      cwd,
      maxCostUsd: costCeilingUsd,
      // v0 set `systemPrompt: objective`, which duplicated the
      // full prompt (execute() also sends it as the user message).
      // The prompt now travels once, as the user message; custom
      // factories may still use the `objective` param for their
      // own system prompts.
      ...(signal ? { abortSignal: signal } : {}),
      // Phase 8 Step 2 / b3 — when a `meshSubmitter` is
      // injected, the agent's `task` tool fires through it.
      // Same DI shape as the sub-agent path in
      // `defaultBuildSubagentFactory` (Package 1).
      ...(opts.meshSubmitter ? { meshSubmitter: opts.meshSubmitter } : {}),
      ...(askHandler !== undefined ? { askHandler } : {}),
    });
  };
}

// ---------------------------------------------------------------------------
// Cross-verify factory (Phase 8 / Step 6)
// ---------------------------------------------------------------------------

/**
 * Phase 8 / Step 6 — `buildEnvoyHarnessAdapterWithCrossVerify`.
 *
 * The EnvoyMesh host's `agent-runtime-envoy/factory.ts`
 * uses this factory to wire envoy-harness with cross-
 * verify on the OpenClaw runtime. The factory:
 * 1. Constructs the `EnvoyHarnessAdapter` with the
 *    usual inputs (buildAgent, signResult, workerPeerId).
 * 2. Adds `crossVerifyWith: defaultCrossVerify(openClawAdapter)`
 *    so `adapter.verify(input)` re-runs the same
 *    skill on the OpenClaw adapter and returns the
 *    local verifier's verdicts for the new result.
 *
 * **Why the factory lives in the bridge, not the host:**
 * the bridge is the seam that knows about both
 * envoy-harness's local verifier rules and the
 * `defaultCrossVerify` closure. The host just hands
 * in the OpenClaw adapter; the bridge composes.
 *
 * **Why the cross adapter is the OpenClaw runtime:**
 * the Q4 (a) design intent is "envoy-writes +
 * OpenClaw-verifies". The orchestrator's
 * `chain-verify-loop` does this at the orchestrator
 * level (escalation step); this factory provides
 * the same primitive at the adapter level (the
 * `verify()` method). The two paths are
 * complementary — the adapter-level path is for
 * callers that want a self-contained cross (e.g.
 * `node-service-impl`'s test seam); the
 * orchestrator-level path is for production Team
 * jobs.
 *
 * **v0 limits (inherited from F9.5 `defaultCrossVerify`):**
 * - `inputArtifacts` is NOT re-passed (the cross
 *   adapter may not have access to the same files;
 *   v0 trusts the worker to include any needed
 *   context in the result content).
 * - `costCeilingUsd: 0` (the orchestrator is the
 *   authoritative budget gate; v0 cross-verify
 *   runs for free to keep the cost predictable).
 * - `deadlineMs: 30_000` (tight; cross-verify
 *   should be fast or the orchestrator escalates).
 *
 * **Stability:** additive. Existing callers that
 * pass `crossVerifyWith` directly are unchanged.
 */
export interface BuildEnvoyHarnessAdapterWithCrossVerifyInput
  extends EnvoyHarnessAdapterInput {
  /**
   * The OpenClaw adapter (or any other
   * `AgentAdapter`) used as the cross-verifier.
   * The factory wires
   * `defaultCrossVerify(openClawAdapter)` so the
   * adapter's `verify()` re-runs the same skill
   * on the cross adapter.
   */
  openClawAdapter: AgentAdapter;
}

export function buildEnvoyHarnessAdapterWithCrossVerify(
  input: BuildEnvoyHarnessAdapterWithCrossVerifyInput,
): EnvoyHarnessAdapter {
  return new EnvoyHarnessAdapter({
    ...input,
    crossVerifyWith: defaultCrossVerify(input.openClawAdapter),
  });
}
