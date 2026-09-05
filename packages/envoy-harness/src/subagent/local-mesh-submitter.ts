/**
 * LocalMeshSubmitter — the default `MeshSubmitter`
 * that runs the sub-agent in a NEW local session.
 *
 * **What this module is:** the "real workable"
 * sub-agent. The parent's `task` tool calls
 * `submit(input, signal)`; the submitter:
 *
 * 1. Builds a fresh `Agent` via the injected
 *    `buildSubagent` factory.
 * 2. Wires the parent's `signal` to the new
 *    agent's abort (so a parent cancel propagates).
 * 3. Calls `agent.run(input.objective)`.
 * 4. Synthesizes a `SubagentResult` from the
 *    `AgentResult`.
 * 5. Returns the result.
 *
 * **Why a factory, not `new Agent(...)` directly:**
 * the host decides the sub-agent's *configuration*
 * (model, tools, hooks, permission, system prompt).
 * The LocalMeshSubmitter is the *plumbing* — the
 * factory is the *policy*. The default factory
 * (`defaultBuildSubagentFactory`) gives a
 * sensible "fresh local session" configuration;
 * the host can override per sub-agent or per
 * capability tag.
 *
 * **Why a NEW session every time:** per design
 * invariant #9, even local sub-agents are
 * independent sessions. The factory's
 * responsibility is to construct a fresh
 * `InMemorySession` (new id, new AGENTS.md, new
 * hooks) per call. The submitter just calls the
 * factory and runs.
 *
 * **Why "v0 unsigned":** the signature on the
 * `SubagentResult` is empty. The parent and the
 * sub-agent are in the same process; no
 * cryptographic trust is needed. The interface
 * supports a signed result (future cross-node
 * `RemoteMeshSubmitter`).
 *
 * **Stability:** additive. New options on the
 * constructor are additive; the `submit` signature
 * is closed (matches `MeshSubmitter`).
 */

import { Agent } from "../agent.js";
import { BUILTIN_TOOLS } from "../tools/builtin/index.js";
import { HookRegistry } from "../hooks/index.js";
import { InMemorySession, newSessionId } from "../session.js";
import { ToolRegistry } from "../tools/index.js";
import type { ModelAdapter } from "../model.js";
import type { PermissionMode } from "../types.js";
import type { Tracer } from "../trace/index.js";

import type {
  MeshSubmitter,
  SubagentInput,
  SubagentRecord,
  SubagentResult,
} from "./types.js";
import type { SubagentResultSigner } from "./signer.js";
import {
  ContinuableSubagentRegistry,
  type ContinuableSubagentHandle,
  type SubmitContinuableOptions,
} from "./continuable.js";

/** Options for `LocalMeshSubmitter`. */
export interface LocalMeshSubmitterOptions {
  /**
   * Factory: build a fresh `Agent` for the
   * sub-agent. The factory's responsibility is to
   * construct a NEW session (id, AGENTS.md, hooks)
   * per call. The host decides the sub-agent's
   * model, tools, permission, system prompt.
   *
   * **The factory may close over the parent's
   * configuration** (e.g. the parent's model) and
   * customize the sub-agent per call (different
   * `capabilityTag` → different tool set).
   */
  buildSubagent: (input: SubagentInput) => Agent;
  /**
   * This node's peerId. Stamped into every
   * `SubagentResult.workerPeerId` so the parent can
   * tell where the sub-agent ran.
   */
  workerPeerId: string;
  /**
   * F10.3.1: optional signer. When provided, the
   * result is signed before returning (the
   * `SubagentResult.signature` field is the
   * signer's output). v0 default: no signer →
   * empty signature (F10.1.2 behavior, backward
   * compatible).
   *
   * **Why the seam:** the host injects the key +
   * the algorithm. envoy-harness doesn't know
   * (or care) about Ed25519, secp256k1, HMAC, etc.
   * The signer is a black box that takes a
   * `SubagentResult` and returns a string.
   *
   * **When to sign:**
   * - Local: usually not needed (parent + sub-agent
   *   are in the same process; no trust boundary).
   * - Cross-process (F10.3.2: `RemoteMeshSubmitter`):
   *   the worker signs the result with its owner
   *   key; the parent verifies using the worker's
   *   public key.
   *
   * **What gets signed:** the entire `SubagentResult`
   * (excluding the `signature` field). The host
   * decides the canonical form; envoy-harness
   * doesn't.
   */
  signer?: SubagentResultSigner;
  /**
   * F10.5: optional parent tracer. When set, the
   * sub-agent's `TraceEvent`s flow to the parent
   * tracer. v0 default: no parent tracer → the
   * sub-agent uses a `NullTracer` (its events are
   * not visible to the parent).
   *
   * **Why the seam:** the sub-agent is a separate
   * session (own CostTracker, own hooks, own
   * permission) but its trace events are useful
   * to the parent for progress streaming. The
   * host injects the tracer; the submitter wires
   * it through the factory to the sub-agent.
   *
   * **Progress streaming:** when set, the parent's
   * UI / log sees the sub-agent's `agent_start`,
   * `model_response`, `tool_call`, `tool_result`,
   * `agent_end`, `error` events in real time. The
   * events are interleaved with the parent's own
   * events (no per-session filter in v0; future:
   * the tracer could enrich events with a
   * `subagentOf: sessionId` field).
   *
   * **Why the seam, not a child tracer:** a
   * "child tracer" wrapper would add a field to
   * every event (the parent's sessionId) — useful,
   * but a separate concern. v0: the parent tracer
   * sees the events as-is. F10.6+ could add
   * `subagentOf` if needed.
   */
  parentTracer?: Tracer;
  /**
   * R4.9a — fired when a continuable (or blocking) sub-agent settles.
   * Blocking `submit()` also invokes this once.
   */
  onSubagentSettle?: (
    result: SubagentResult,
    record: SubagentRecord,
  ) => void;
}

/**
 * The default `MeshSubmitter` for local execution.
 *
 * **v0 limits:**
 * - The result is unsigned (local; no trust needed).
 * - The verdict is a simple synthesis from the
 *   agent's `stopReason` + content. Future:
 *   `runLocalVerifier(result.messages, input.objective)`.
 * - The parent's signal aborts the sub-agent's
 *   internal `AbortController` (next iteration
 *   boundary).
 * - Concurrency: v0 is single-threaded; the host
 *   can `Promise.all` over multiple `submit()`
 *   calls if it wants parallel sub-agents.
 */
export class LocalMeshSubmitter implements MeshSubmitter {
  private readonly buildSubagent: (input: SubagentInput) => Agent;
  private readonly workerPeerId: string;
  private readonly signer: SubagentResultSigner | undefined;
  private readonly onSubagentSettle:
    | ((result: SubagentResult, record: SubagentRecord) => void)
    | undefined;
  private readonly subagents: SubagentRecord[] = [];
  private readonly continuable: ContinuableSubagentRegistry;

  constructor(options: LocalMeshSubmitterOptions) {
    this.buildSubagent = options.buildSubagent;
    this.workerPeerId = options.workerPeerId;
    this.signer = options.signer;
    this.onSubagentSettle = options.onSubagentSettle;
    this.continuable = new ContinuableSubagentRegistry({
      buildSubagent: this.buildSubagent,
      workerPeerId: this.workerPeerId,
      ...(this.signer !== undefined ? { signer: this.signer } : {}),
      records: this.subagents,
    });
  }

  /**
   * R4.9a — spawn a continuable local sub-agent. Returns immediately
   * with a handle; the objective runs in the background.
   */
  submitContinuable(
    input: SubagentInput,
    options: SubmitContinuableOptions = {},
  ): ContinuableSubagentHandle {
    const onSettle = options.onSettle ?? this.onSubagentSettle;
    return this.continuable.submitContinuable(input, {
      ...options,
      autoSettleAfterIdle: options.autoSettleAfterIdle ?? false,
      ...(onSettle !== undefined ? { onSettle } : {}),
    });
  }

  getHandle(id: string): ContinuableSubagentHandle | undefined {
    return this.continuable.getHandle(id);
  }

  async submit(
    input: SubagentInput,
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    // Backward-compatible one-shot: continuable + auto-settle + wait.
    const handle = this.continuable.submitContinuable(input, {
      parentSignal: signal,
      autoSettleAfterIdle: true,
      ...(this.onSubagentSettle !== undefined
        ? { onSettle: this.onSubagentSettle }
        : {}),
    });
    return handle.waitSettle({ signal });
  }

  listSubagents(): ReadonlyArray<SubagentRecord> {
    return this.subagents;
  }
}

// ---------------------------------------------------------------------------
// Default factory: a fresh local session with BUILTIN_TOOLS + read-only
// ---------------------------------------------------------------------------

/** Options for the default factory. */
export interface DefaultBuildSubagentFactoryOptions {
  /** The sub-agent's model. */
  model: ModelAdapter;
  /** Working directory. Default: `process.cwd()`. */
  cwd?: string;
  /** Permission mode. Default: `"read-only"`. The
   *  sub-agent's own policy, not the requester's. */
  permissionMode?: PermissionMode;
  /** Optional system prompt prefix. The full system
   *  prompt is `prefix + "Sub-agent objective: " +
   *  objective`. */
  systemPromptPrefix?: string;
  /**
   * F10.5: optional parent tracer. When set, the
   * sub-agent's `TraceEvent`s flow to the parent
   * tracer (for progress streaming). v0 default:
   * no parent tracer → the sub-agent uses a
   * `NullTracer` (its events are not visible to
   * the parent).
   *
   * **When to set:** when the host wants the
   * parent to see the sub-agent's progress
   * (e.g. for a streaming UI). Most hosts want
   * this; it's the default for production. v0:
   * opt-in via this field; the host decides.
   */
  parentTracer?: Tracer;
  /**
   * F10.6: the parent session id. When set, the
   * sub-agent's `AgentOptions.subagentOf` is set
   * to this value, so every trace event the
   * sub-agent emits carries `subagentOf:
   * <parentSessionId>`. The parent tracer (or any
   * downstream consumer) can then group/filter
   * events by `subagentOf` without inferring from
   * event ordering.
   *
   * **Who sets it:** the host, when constructing
   * the `LocalMeshSubmitter` (and the factory).
   * The host knows its own `session.id`; it
   * passes it to the factory via this field. The
   * factory closes over the value and passes it
   * to every new `Agent` it creates.
   *
   * **When to set:** when the host has a
   * `parentTracer` (F10.5) AND wants the
   * sub-agent's events to be self-describing.
   * They're independent: you can have a
   * `parentTracer` without `parentSessionId`
   * (events flow to the parent but don't carry
   * the field); you can have `parentSessionId`
   * without `parentTracer` (events carry the
   * field but go to a `NullTracer`).
   */
  parentSessionId?: string;
}

/**
 * The default `buildSubagent` factory: a fresh
 * `InMemorySession` + the BUILTIN_TOOLS + the given
 * model + read-only permission. The host can
 * override per sub-agent by injecting a different
 * factory.
 *
 * **The session is fresh per call.** `newSessionId()`
 * generates a new id; the `InMemorySession` is a
 * new object. The parent's session is never shared
 * with the sub-agent. This is the design invariant:
 * sub-agents are independent sessions, even locally.
 */
export function defaultBuildSubagentFactory(
  options: DefaultBuildSubagentFactoryOptions,
): (input: SubagentInput) => Agent {
  const cwd = options.cwd ?? process.cwd();
  const permissionMode = options.permissionMode ?? "read-only";
  const prefix = options.systemPromptPrefix ?? "";
  return (input: SubagentInput) => {
    const session = new InMemorySession(newSessionId(), {
      cwd,
      permissionMode,
      startedAt: new Date().toISOString(),
    });
    const tools = new ToolRegistry();
    for (const t of BUILTIN_TOOLS) tools.register(t);
    const hooks = new HookRegistry();
    const systemPrompt = [
      prefix,
      `You are a sub-agent invoked by the parent's \`task\` tool.`,
      `Capability tag: ${input.capabilityTag}`,
      `Objective: ${input.objective}`,
      `Stay within your cost ceiling ($${input.costCeilingUsd.toFixed(2)}) and deadline (${input.deadlineMs}ms).`,
      `Your permission mode is \`${permissionMode}\`.`,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
    return new Agent({
      model: options.model,
      tools,
      session,
      hooks,
      cwd,
      maxCostUsd: input.costCeilingUsd,
      systemPrompt,
      ...(options.parentTracer ? { tracer: options.parentTracer } : {}),
      ...(options.parentSessionId ? { subagentOf: options.parentSessionId } : {}),
    });
  };
}
