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

import { Agent, HookRegistry, InMemorySession, newSessionId, ToolRegistry, type ModelAdapter } from "../index.js";
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
}

/** The runner. */
export class Team {
  private readonly config: TeamConfig;
  private readonly model: ModelAdapter;
  private readonly cwd: string;
  private readonly optionsFor: ((spec: AgentSpec) => Partial<ConstructorParameters<typeof Agent>[0]>) | undefined;
  private readonly input: string;

  constructor(options: TeamOptions) {
    this.config = options.config;
    this.model = options.model;
    this.cwd = options.cwd ?? process.cwd();
    this.optionsFor = options.optionsFor;
    this.input = options.input ?? "";
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
    // 1. Validate + topological sort.
    const order = topologicalSort(this.config.agents);
    const results = new Map<string, AgentRunResult>();

    // 2. Run each agent in order.
    for (const spec of order) {
      const startedAt = Date.now();
      const upstreamContext = this.buildUpstreamContext(spec, results);
      const objective = substituteInput(spec.objective, this.input);
      const prompt = upstreamContext
        ? `${objective}\n\nContext from upstream agents:\n${upstreamContext}`
        : objective;
      try {
        const { text, stopReason } = await this.runAgent(spec, prompt);
        // Record the agent's output even when it failed (the
        // transcript / error text is useful context).
        results.set(spec.id, {
          id: spec.id,
          finalText: text,
          stopReason,
          durationMs: Date.now() - startedAt,
        });
        if (stopReason === "aborted") {
          // The agent's run caught an internal error
          // (e.g. a model error) and returned an
          // "aborted" result instead of throwing.
          // Treat it as a per-agent failure.
          return {
            teamName: this.config.name,
            agents: Array.from(results.values()),
            status: "failed",
            error: `agent ${spec.id} aborted (see transcript for details)`,
          };
        }
      } catch (err) {
        return {
          teamName: this.config.name,
          agents: Array.from(results.values()),
          status: "failed",
          error: `agent ${spec.id} failed: ${(err as Error).message}`,
        };
      }
    }

    return {
      teamName: this.config.name,
      agents: Array.from(results.values()),
      status: "completed",
    };
  }

  // --- helpers ---

  private async runAgent(
    spec: AgentSpec,
    prompt: string,
  ): Promise<{ text: string; stopReason: string }> {
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
      systemPrompt: spec.systemPrompt,
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
