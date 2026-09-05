/**
 * Team runner — executes a `TeamConfig` once.
 *
 * **What this module does:**
 * 1. Topologically sorts the agents by `dependsOn`.
 * 2. For each agent, in order:
 *    - Builds a system prompt (the agent's
 *      `systemPrompt`).
 *    - Builds the user message: the agent's
 *      `objective` (with `${input}` substituted
 *      to the team-level input) + the upstream
 *      agents' final text.
 *    - Constructs an `Agent` with the configured
 *      model + the message + the system prompt.
 *    - Runs the agent; captures the final text.
 * 3. Returns a `TeamResult` with per-agent results
 *    in execution order.
 *
 * **Why topological sort:** a downstream agent
 * shouldn't run before its upstream agents finish.
 * The sort gives a stable order; ties (no shared
 * ancestor) preserve TOML order.
 *
 * **Why in-process:** v0 has no distributed
 * execution. The host (system cron, k8s CronJob)
 * calls `runOnce()` on schedule. The orchestrator
 * can run multiple teams in parallel by spawning
 * multiple `Team.runOnce()` calls in different
 * processes.
 *
 * **Why error-on-missing-dependency:** a typo'd
 * `dependsOn` ID is a bug, not a soft failure.
 * The runner fails fast with a clear error
 * ("agent X depends on Y, but Y is not in the
 * team"). The host sees the error in the result.
 *
 * **Why error-on-cycle:** a cycle is a bug in
 * the config. The runner detects cycles during
 * topological sort and throws.
 *
 * **Stability:** `Team` (class) is the public
 * surface. Additive; new options on the
 * constructor are additive.
 */

import {
  Agent,
  buildAgentSystemPrompt,
  HookRegistry,
  InMemorySession,
  newSessionId,
  ToolRegistry,
  type ModelAdapter,
} from "../index.js";
import type { AgentRunResult, AgentSpec, TeamConfig, TeamResult } from "./types.js";

/** Options for `Team`. */
export interface TeamOptions {
  /** The team config (parsed from TOML). */
  config: TeamConfig;
  /** The model adapter. Used for every agent. */
  model: ModelAdapter;
  /** Working directory. Default: `process.cwd()`. */
  cwd?: string;
  /**
   * Optional factory: receive an `AgentSpec` and
   * return a partial `AgentOptions` to merge
   * with the defaults. Used to customize the
   * tool registry, hook registry, tracer, etc.
   * per agent. Default: a fresh `ToolRegistry()`
   * (no tools) + the default `HookRegistry()`
   * (no hooks) for every agent.
   */
  optionsFor?: (spec: AgentSpec) => Partial<ConstructorParameters<typeof Agent>[0]>;
  /**
   * Optional input substitution. The team-level
   * input is used to substitute `${input}` in
   * each agent's `objective`. Default: empty
   * string.
   */
  input?: string;
  /**
   * D4 — dispatch an agent whose `spec.host` is `"peer://<id>"`. The
   * peer package (`@envoymesh/envoy-harness-peer`) provides the
   * implementation (`createPeerTeamExecutor`); Package 1 only declares
   * the seam. Absent → a peer-hosted agent fails with a clear error.
   */
  peerExecutor?: (spec: AgentSpec, prompt: string) => Promise<string>;
  /**
   * R4.7 — optional lifecycle callbacks for live `team/jobs` boards
   * (standalone peer path / hosts). Fired around `runOnce()`.
   */
  onTeamStart?: (ctx: {
    teamName: string;
    agents: ReadonlyArray<AgentSpec>;
  }) => void;
  onAgentStart?: (ctx: { teamName: string; spec: AgentSpec }) => void;
  onAgentFinish?: (ctx: {
    teamName: string;
    spec: AgentSpec;
    result: AgentRunResult;
  }) => void;
  onTeamFinish?: (ctx: { result: TeamResult }) => void;
  /**
   * R4.8 — when true (default), agents whose dependencies are
   * satisfied run concurrently in waves. When false, run the
   * classic sequential topological order.
   */
  parallel?: boolean;
  /**
   * R4.8 — retry a failed agent this many extra times before
   * failing the team. Default 0 (no retries).
   */
  maxRetries?: number;
}

/** The runner. */
export class Team {
  private readonly config: TeamConfig;
  private readonly model: ModelAdapter;
  private readonly cwd: string;
  private readonly optionsFor: ((spec: AgentSpec) => Partial<ConstructorParameters<typeof Agent>[0]>) | undefined;
  private readonly input: string;
  private readonly peerExecutor:
    | ((spec: AgentSpec, prompt: string) => Promise<string>)
    | undefined;
  private readonly onTeamStart: TeamOptions["onTeamStart"];
  private readonly onAgentStart: TeamOptions["onAgentStart"];
  private readonly onAgentFinish: TeamOptions["onAgentFinish"];
  private readonly onTeamFinish: TeamOptions["onTeamFinish"];
  private readonly parallel: boolean;
  private readonly maxRetries: number;

  constructor(options: TeamOptions) {
    this.config = options.config;
    this.model = options.model;
    this.cwd = options.cwd ?? process.cwd();
    this.optionsFor = options.optionsFor;
    this.input = options.input ?? "";
    this.peerExecutor = options.peerExecutor;
    this.onTeamStart = options.onTeamStart;
    this.onAgentStart = options.onAgentStart;
    this.onAgentFinish = options.onAgentFinish;
    this.onTeamFinish = options.onTeamFinish;
    this.parallel = options.parallel !== false;
    this.maxRetries = Math.max(0, options.maxRetries ?? 0);
  }

  /**
   * Execute the team once. Returns a `TeamResult`
   * with per-agent results in execution order.
   *
   * **Errors:** if the team has a missing
   * dependency (an ID in `dependsOn` that doesn't
   * exist) or a cycle, throws immediately. The
   * caller catches the error and decides what to
   * do (log, surface to the user, etc.).
   *
   * **Per-agent errors:** if an individual agent
   * throws (e.g. model error), the team result
   * is `status: "failed"` and includes the error
   * message. The agents that ran before the
   * failure are still in the result.
   */
  async runOnce(): Promise<TeamResult> {
    // Validate graph (missing deps / cycles) via topological sort.
    const order = topologicalSort(this.config.agents);
    const byId = new Map(order.map((a) => [a.id, a]));
    const results = new Map<string, AgentRunResult>();
    this.onTeamStart?.({
      teamName: this.config.name,
      agents: order,
    });

    if (!this.parallel) {
      return this.runSequential(order, results);
    }
    return this.runParallelWaves(byId, results);
  }

  private async runSequential(
    order: ReadonlyArray<AgentSpec>,
    results: Map<string, AgentRunResult>,
  ): Promise<TeamResult> {
    for (const spec of order) {
      const outcome = await this.runOneAgent(spec, results);
      if (outcome.kind === "failed") {
        this.onTeamFinish?.({ result: outcome.result });
        return outcome.result;
      }
    }
    const completed: TeamResult = {
      teamName: this.config.name,
      agents: Array.from(results.values()),
      status: "completed",
    };
    this.onTeamFinish?.({ result: completed });
    return completed;
  }

  private async runParallelWaves(
    byId: Map<string, AgentSpec>,
    results: Map<string, AgentRunResult>,
  ): Promise<TeamResult> {
    const remaining = new Set(byId.keys());
    while (remaining.size > 0) {
      const ready = [...remaining]
        .map((id) => byId.get(id)!)
        .filter((spec) =>
          spec.dependsOn.every((dep) => results.has(dep)),
        );
      if (ready.length === 0) {
        throw new Error(
          "team runner: no ready agents while remaining work exists (internal)",
        );
      }
      const wave = await Promise.all(
        ready.map((spec) => this.runOneAgent(spec, results)),
      );
      for (const outcome of wave) {
        if (outcome.kind === "failed") {
          this.onTeamFinish?.({ result: outcome.result });
          return outcome.result;
        }
        remaining.delete(outcome.specId);
      }
    }
    const completed: TeamResult = {
      teamName: this.config.name,
      agents: Array.from(results.values()),
      status: "completed",
    };
    this.onTeamFinish?.({ result: completed });
    return completed;
  }

  private async runOneAgent(
    spec: AgentSpec,
    results: Map<string, AgentRunResult>,
  ): Promise<
    | { kind: "ok"; specId: string }
    | { kind: "failed"; result: TeamResult }
  > {
    const startedAt = Date.now();
    this.onAgentStart?.({ teamName: this.config.name, spec });
    const upstreamContext = this.buildUpstreamContext(spec, results);
    const objective = substituteInput(spec.objective, this.input);
    const prompt = upstreamContext
      ? `${objective}\n\nContext from upstream agents:\n${upstreamContext}`
      : objective;

    let lastError: Error | undefined;
    const attempts = 1 + this.maxRetries;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const { text, stopReason } = await this.runAgent(spec, prompt);
        const agentResult: AgentRunResult = {
          id: spec.id,
          finalText: text,
          stopReason,
          durationMs: Date.now() - startedAt,
        };
        if (stopReason === "aborted") {
          if (attempt + 1 < attempts) {
            continue;
          }
          results.set(spec.id, agentResult);
          this.onAgentFinish?.({
            teamName: this.config.name,
            spec,
            result: agentResult,
          });
          return {
            kind: "failed",
            result: {
              teamName: this.config.name,
              agents: Array.from(results.values()),
              status: "failed",
              error: `agent ${spec.id} aborted (see transcript for details)`,
            },
          };
        }
        results.set(spec.id, agentResult);
        this.onAgentFinish?.({
          teamName: this.config.name,
          spec,
          result: agentResult,
        });
        return { kind: "ok", specId: spec.id };
      } catch (err) {
        lastError = err as Error;
        if (attempt + 1 >= attempts) break;
      }
    }
    const failedResult: AgentRunResult = {
      id: spec.id,
      finalText: lastError?.message ?? "unknown",
      stopReason: "aborted",
      durationMs: Date.now() - startedAt,
    };
    results.set(spec.id, failedResult);
    this.onAgentFinish?.({
      teamName: this.config.name,
      spec,
      result: failedResult,
    });
    return {
      kind: "failed",
      result: {
        teamName: this.config.name,
        agents: Array.from(results.values()),
        status: "failed",
        error: `agent ${spec.id} failed: ${lastError?.message ?? "unknown"}`,
      },
    };
  }

  // --- helpers ---

  private async runAgent(
    spec: AgentSpec,
    prompt: string,
  ): Promise<{ text: string; stopReason: string }> {
    // D4 — peer-hosted agents dispatch through the host's peer executor
    // (the peer package routes via PeerRegistry + PeerMeshSubmitter).
    if (spec.host !== undefined && spec.host !== "local") {
      if (this.peerExecutor === undefined) {
        throw new Error(
          `agent ${spec.id} host "${spec.host}" requires TeamOptions.peerExecutor ` +
            "(provided by @envoymesh/envoy-harness-peer's createPeerTeamExecutor)",
        );
      }
      const text = await this.peerExecutor(spec, prompt);
      return { text, stopReason: "end_turn" };
    }
    const session = new InMemorySession(newSessionId(), {
      cwd: this.cwd,
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const tools = new ToolRegistry();
    const hooks = new HookRegistry();
    const partial = this.optionsFor?.(spec) ?? {};
    const agent = new Agent({
      model: this.model,
      tools,
      session,
      hooks,
      cwd: this.cwd,
      // Phase G — when the team spec doesn't pin a system prompt, fall
      // back to the default assembly (AGENTS.md discovery + guidance).
      systemPrompt:
        spec.systemPrompt ??
        (await buildAgentSystemPrompt({ cwd: this.cwd })),
      ...partial,
    });
    const result = await agent.run(prompt);
    const text = result.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { text, stopReason: result.stopReason };
  }

  private buildUpstreamContext(
    spec: AgentSpec,
    results: Map<string, AgentRunResult>,
  ): string {
    if (spec.dependsOn.length === 0) return "";
    const lines: string[] = [];
    for (const dep of spec.dependsOn) {
      const r = results.get(dep);
      if (!r) {
        // Defensive: topological sort should have
        // caught this, but if a cycle slipped
        // through, surface it here.
        throw new Error(
          `agent ${spec.id} depends on ${dep}, but ${dep} has not run yet`,
        );
      }
      lines.push(`[${r.id}]: ${r.finalText}`);
    }
    return lines.join("\n\n");
  }
}

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

/**
 * Sort the agents in topological order (each agent
 * comes after all of its `dependsOn` agents). Throws
 * on missing dependency or cycle.
 */
function topologicalSort(
  agents: ReadonlyArray<AgentSpec>,
): ReadonlyArray<AgentSpec> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  // Validate every dependsOn.
  for (const a of agents) {
    for (const dep of a.dependsOn) {
      if (!byId.has(dep)) {
        throw new Error(
          `agent ${a.id} depends on ${dep}, but ${dep} is not in the team`,
        );
      }
    }
  }
  // Kahn's algorithm: process nodes with in-degree 0
  // first, then remove their outgoing edges.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const a of agents) {
    inDegree.set(a.id, a.dependsOn.length);
    for (const dep of a.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(a.id);
      dependents.set(dep, list);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  const order: AgentSpec[] = [];
  while (queue.length > 0) {
    // Pop the first; preserve insertion order for
    // ties.
    const id = queue.shift()!;
    const spec = byId.get(id);
    if (!spec) {
      throw new Error(`internal: missing spec for ${id}`);
    }
    order.push(spec);
    for (const next of dependents.get(id) ?? []) {
      const nextDeg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
    }
  }
  if (order.length !== agents.length) {
    throw new Error(
      `team has a cycle: topological sort produced ${order.length} of ${agents.length} agents`,
    );
  }
  return order;
}

/** Replace `${input}` with the team-level input. */
function substituteInput(objective: string, input: string): string {
  return objective.replace(/\$\{input\}/g, input);
}
