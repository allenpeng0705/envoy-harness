/**
 * Agent — the main loop that drives model ↔ tool execution.
 *
 * **Design doc:** `docs/design.md` §3 (runtime core).
 *
 * **The loop (per design §3.4):**
 *
 * 1. Append the user's prompt to the session.
 * 2. Call the model with the full transcript + available tools.
 * 3. Append the assistant's response to the session.
 * 4. If the response has no tool calls, return the result.
 * 5. For each tool call:
 *    a. Fire `PreToolUse` hook; abort if `block`.
 *    b. Validate args against the tool's zod schema.
 *    c. Execute the tool.
 *    d. Fire `PostToolUse` hook; honor `modify`.
 *    e. Append the tool result to the session.
 * 6. Loop back to step 2.
 *
 * **Max iterations:** the loop is bounded by `maxIterations`
 * (default 50). If exceeded, the agent throws — the orchestrator
 * (CLI / mesh) is responsible for retry / abort policy. A
 * runaway loop is a configuration error, not a recoverable
 * condition.
 *
 * **Error handling:** tool exceptions are caught and turned into
 * `isError: true` tool results. The model can read the error
 * message and try again. Only the `maxIterations` exhaustion
 * is a hard throw.
 *
 * **Hook integration:** PreToolUse / PostToolUse are wired in.
 * The other 10 hook events (SessionStart, PreCompact, etc.) are
 * fired by the orchestrator (CLI / mesh), not the agent loop.
 * Per design §8.1, the agent loop is one of several fire sites.
 *
 * **Stability:** the public API is `run()`. Adding new options
 * (e.g. `systemPrompt`) is additive.
 */

import {
  defaultRegistry,
  HookRegistry,
  type HookDecision,
} from "./hooks/index.js";
import { InMemorySession, newSessionId } from "./session.js";
import type { ModelAdapter, ModelResponse } from "./model.js";
import type { Session } from "./session.js";
import type { ContentBlock, ToolRegistry } from "./tools/index.js";
import type {
  AskForApproval,
  AskHandler,
  AskRequest,
  PermissionMode,
  SandboxPolicy,
} from "./types.js";
import { CostTracker } from "./cost.js";
import { policyFromMode } from "./permissions/policy.js";
import type { LspManager } from "./lsp/index.js";
import { makeLspTools } from "./lsp/tools.js";
import { NullTracer } from "./trace/null-tracer.js";
import type { Tracer } from "./trace/index.js";
import type { MeshSubmitter, SubagentResult } from "./subagent/index.js";
import { makeTaskTool } from "./subagent/tools.js";
import type { FanOutRegistry } from "./subagent/fan-out.js";

/** Default max iterations before the agent throws. */
export const DEFAULT_MAX_ITERATIONS = 50;
/** F10.2: default cap on sub-agents per turn.
 *  Picked to be generous (the model rarely needs
 *  more than 3-4 sub-agents in one turn) while
 *  still bounding cost. The host can lower this
 *  for production. */
export const DEFAULT_MAX_SUBAGENTS = 8;

export interface AgentOptions {
  /** The model adapter. Required. */
  model: ModelAdapter;
  /** The tool registry. The agent looks up tools by name. */
  tools: ToolRegistry;
  /** The session. The agent appends to its transcript. */
  session: Session;
  /** Hook registry. Defaults to the singleton `defaultRegistry`. */
  hooks?: HookRegistry;
  /** Working directory for tool execution. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Max iterations before throwing. Default 50. */
  maxIterations?: number;
  /**
   * Abort signal. When aborted, the agent stops the loop and
   * any in-flight tool is canceled (via the `ToolContext`'s
   * `abortSignal`).
   */
  abortSignal?: AbortSignal;
  /**
   * Optional system prompt. Prepended to the transcript as a
   * system message before the first model call. v0 simply
   * appends; adapters that prefer separate system channels
   * can read the first system message and inject it natively.
   */
  systemPrompt?: string;
  /**
   * F7.5: cost ceiling. When the accumulated
   * `costTracker.total().costUsd` exceeds this number, the
   * agent aborts (sets `stopReason: "aborted"`). The check
   * happens after every model call that reports `usage`.
   * `0` means "no cap" (the cross-verify path passes 0 as
   * "free"; a $0 ceiling would abort on the first token
   * spend). Default: no cap.
   */
  maxCostUsd?: number;
  /**
   * F9.1: per-call approval handler. When a hook returns
   * `kind: "ask"`, the agent loop pauses and calls this
   * handler. The handler returns an `AskDecision`
   * (allow / deny / modify). When `undefined`, the agent
   * defaults to `deny` (safe default — the tool is
   * blocked with "no ask handler configured").
   */
  askHandler?: AskHandler;
  /**
   * F9.2: LSP manager. When provided, the 4 LSP tools
   * (`lsp_definition`, `lsp_references`, `lsp_hover`,
   * `lsp_diagnostics`) are auto-registered with the
   * tool registry. No manager → no LSP tools (the
   * model's tool list doesn't mention LSP at all).
   *
   * **Lifecycle:** the agent does NOT close the
   * manager. The host (Tauri, the CLI) owns the
   * `LspManager`'s lifecycle; the agent borrows it for
   * the duration of a run.
   */
  lspManager?: LspManager;
  /**
   * F9.4: tracer. When undefined, a `NullTracer` is
   * used (no observable side effect). The CLI's
   * `--json` flag wires a `JsonLinesTracer` to stdout.
   *
   * **Sync contract:** `Tracer.emit` is synchronous.
   * The agent does not await; a tracer that needs
   * async I/O must buffer.
   */
  tracer?: Tracer;
  /**
   * F10.1: mesh submitter. When set, the `task`
   * tool is auto-registered with the parent's tool
   * registry. The model can spawn sub-agents via
   * the `task` tool; the submitter decides where
   * the sub-agent runs (locally, on a peer, etc.).
   *
   * **No submitter → no `task` tool.** The model
   * never sees the tool if the host hasn't
   * configured a submitter. This is the
   * "opt-in" pattern: sub-agents are an explicit
   * capability the host turns on.
   *
   * **Default submitter:** `LocalMeshSubmitter` +
   * `defaultBuildSubagentFactory` are the
   * recommended defaults for a same-node host.
   * Cross-node hosts inject a future
   * `RemoteMeshSubmitter`.
   */
  meshSubmitter?: MeshSubmitter;
  /**
   * F10.2: max sub-agents per turn. Hard cap
   * on the number of `task` calls the model
   * can emit in a single iteration. Default: 8.
   *
   * **When exceeded:** the agent refuses ALL the
   * `task` calls in that turn (returns one
   * `isError: true` tool_result per refused call
   * with the message `"maxSubagents reached: N
   * task calls in one turn (cap is M). Refused."`).
   * **Why refuse all, not partial:** partial runs
   * would hide the constraint from the model;
   * refusing all teaches the model to budget
   * its sub-agents.
   *
   * **Sub-agent cost:** the parent's `maxCostUsd`
   * cap is unchanged (it's a per-Agent cap, only
   * the parent's model calls). Sub-agents have
   * their own `CostTracker`s. The host budgets
   * sub-agents separately via each `task` call's
   * `cost_ceiling_usd`.
   */
  maxSubagents?: number;
  /**
   * F10.4.1: optional fan-out registry. When set,
   * the `task` tool consults the registry on every
   * call. If a `FanOutSpec` matches the input's
   * `capability_tag`, the tool expands ONE model
   * call into N parallel sub-agents (per the
   * spec's `count`), then aggregates the N results
   * into ONE for the model.
   *
   * **No registry → no fan-out** (F10.1 + F10.2
   * baseline). The model emits N `task` calls;
   * the agent runs them in parallel. With a
   * registry, the host controls fan-out without
   * teaching the model about it.
   *
   * **Example:** the host wants every
   * `capability_tag: "research"` call to fan out
   * to 3 sub-agents with different objectives.
   * The model emits ONE call; the registry
   * expands it. The model sees ONE result.
   */
  fanOutRegistry?: FanOutRegistry;
  /**
   * F10.6: the parent session id, when this
   * `Agent` is a SUB-agent. When set, every
   * `TraceEvent` emitted by this agent carries
   * `subagentOf: <parentSessionId>`. The PARENT's
   * own agents do NOT set this (the parent is the
   * root; its events have no `subagentOf`).
   *
   * **Who sets it:** the `LocalMeshSubmitter`'s
   * `defaultBuildSubagentFactory` (when `parentTracer`
   * is set) and the F10.3.2 `RemoteMeshSubmitter`
   * factory. The host doesn't set this directly;
   * the submitter does.
   *
   * **Why a separate field, not just `sessionId`:**
   * the sub-agent has its own `sessionId` (the
   * sub-agent's own `AgentStartEvent.sessionId`).
   * `subagentOf` points UP to the parent, separate
   * from the sub-agent's own id. A Tauri UI showing
   * a tree (parent → 3 sub-agents) uses
   * `subagentOf` for the parent edge and
   * `sessionId` for the child node.
   */
  subagentOf?: string;
  /**
   * Approval policy for the session. Controls how `ask`
   * hook decisions are resolved:
   *
   * - `never`: asks are denied unconditionally (fail-closed,
   *   even if a host installed an allow-ing `askHandler`).
   * - `unless-trusted` / `on-request` / `granular`: asks are
   *   delegated to `askHandler` (default: deny when no handler
   *   is installed).
   *
   * Default: `on-request` (delegate). v0 has no per-tool
   * trust metadata, so `unless-trusted` and `granular` behave
   * like `on-request` until such metadata exists.
   */
  approval?: import("./types.js").AskForApproval;
}

/** What `Agent.run()` returns. */
export interface AgentResult {
  /** The final assistant content blocks. */
  content: ContentBlock[];
  /**
   * Why the loop exited. `tool_use` is the model's own signal
   * (it emitted tool calls but the model stop reason is still
   * `end_turn` after the agent executes them). `max_iterations`
   * is the agent's own bound. `aborted` is the user / system.
   */
  stopReason:
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "stop_sequence"
    | "max_iterations"
    | "aborted";
  /** Number of model calls made. */
  iterations: number;
  /** Total tool calls executed. */
  toolCalls: number;
  /**
   * The full transcript (system + user + assistant + tool). The
   * verifier reads from this to check sandbox-respect and
   * approval-respect. v0 exposes the full transcript so the
   * verifier can see exactly what the worker did.
   */
  messages: ReadonlyArray<import("./tools/index.js").Message>;
  /**
   * Effective sandbox policy. The verifier's `sandbox-respected`
   * rule uses this to bound which paths are allowed.
   */
  sandboxPolicy: SandboxPolicy;
  /**
   * Accumulated cost + token metrics across the run. F7.1:
   * populated from each `ModelResponse.usage` via the
   * `CostTracker`. `costUsd` is 0 when no usage was reported
   * (e.g. FakeModel, local models, or adapters that don't
   * surface usage).
   */
  metrics: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

export class Agent {
  private model: ModelAdapter;
  private tools: ToolRegistry;
  private session: Session;
  private hooks: HookRegistry;
  private cwd: string;
  private maxIterations: number;
  private abortController: AbortController;
  private systemPrompt: string | undefined;
  private toolCallCount = 0;
  /** Effective sandbox policy, derived from the session. The verifier reads this. */
  private sandboxPolicy: SandboxPolicy;
  /** Cost tracker; populated across the run. F7.1. */
  private costTracker: CostTracker;
  /** F7.5: cost ceiling; when exceeded, the agent aborts. */
  private maxCostUsd: number | undefined;
  /** F9.1: per-call approval handler. */
  private askHandler: AskHandler | undefined;
  /** F9.2: LSP manager (when provided, the 4 LSP tools are registered). */
  private lspManager: LspManager | undefined;
  /** F9.4: tracer. Always non-null (defaults to NullTracer). */
  private tracer: Tracer;
  /** F10.1: mesh submitter. When set, the `task` tool
   *  is auto-registered in the constructor. */
  private meshSubmitter: MeshSubmitter | undefined;
  /** F10.4.1: fan-out registry. When set, the `task`
   *  tool consults it on every call. */
  private fanOutRegistry: FanOutRegistry | undefined;
  /** F10.2: max sub-agents per turn. */
  private maxSubagents: number;
  /** F10.6: parent session id (when this is a
   *  sub-agent). Every `TraceEvent.emit` includes
   *  this as `subagentOf` so the parent tracer can
   *  attribute events without consumer-side
   *  inference. Undefined for the root agent. */
  private subagentOf: string | undefined;
  /** F-fix: approval policy. Defaults to `on-request`. */
  private approval: AskForApproval;

  constructor(options: AgentOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.session = options.session;
    this.hooks = options.hooks ?? defaultRegistry;
    this.cwd = options.cwd ?? process.cwd();
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxCostUsd =
      options.maxCostUsd !== undefined && options.maxCostUsd > 0
        ? options.maxCostUsd
        : undefined;
    this.askHandler = options.askHandler;
    this.lspManager = options.lspManager;
    this.tracer = options.tracer ?? new NullTracer();
    this.meshSubmitter = options.meshSubmitter;
    this.fanOutRegistry = options.fanOutRegistry;
    this.maxSubagents = options.maxSubagents ?? DEFAULT_MAX_SUBAGENTS;
    this.subagentOf = options.subagentOf;
    this.approval = options.approval ?? "on-request";
    // F9.2: register the 4 LSP tools when the host provides
    // a manager. We do this AFTER the constructor sets
    // `this.tools` so the registry is available.
    if (this.lspManager) {
      for (const tool of makeLspTools(this.lspManager)) {
        this.tools.register(tool);
      }
    }
    // F10.1: register the `task` tool when the host
    // provides a MeshSubmitter. Without one, the
    // model never sees the tool (opt-in).
    if (this.meshSubmitter) {
      // F10.5: cost aggregation callback. When the
      // task tool returns a SubagentResult (single
      // or fan-out aggregated), the parent adds the
      // result's costUsd to its own CostTracker. The
      // callback is wired through the tool to keep
      // the tool ignorant of the parent's tracker.
      const onSubagentComplete = (result: SubagentResult): void => {
        if (result.costUsd > 0) {
          this.costTracker.addSubagentCost(result.costUsd);
        }
        // F-fix: sub-agent costs count toward the parent's cap.
        // The cap check normally runs after model calls; this is
        // the only point where sub-agent costs enter the tracker.
        if (this.maxCostUsd !== undefined) {
          const total = this.costTracker.total();
          if (total.costUsd > this.maxCostUsd) {
            this.abortController.abort(
              `max-cost-usd exceeded (incl. sub-agent costs): $${total.costUsd.toFixed(4)} > $${this.maxCostUsd}`,
            );
          }
        }
      };
      this.tools.register(
        makeTaskTool({
          submitter: this.meshSubmitter,
          ...(this.fanOutRegistry ? { fanOutRegistry: this.fanOutRegistry } : {}),
          onSubagentComplete,
          maxSubagents: this.maxSubagents,
        }),
      );
    }
    if (options.abortSignal) {
      // Wrap caller-provided signal so we can also fire on
      // internal errors without leaking listeners.
      this.abortController = new AbortController();
      if (options.abortSignal.aborted) {
        this.abortController.abort(options.abortSignal.reason);
      } else {
        options.abortSignal.addEventListener(
          "abort",
          () => this.abortController.abort(options.abortSignal!.reason),
          { once: true },
        );
      }
    } else {
      this.abortController = new AbortController();
    }
    this.systemPrompt = options.systemPrompt;
    // Build the sandbox policy from the session's permission mode.
    // The bash tool uses this (via ToolContext) so runtime policy
    // changes (`setPermissionMode`) take effect on the next call.
    this.sandboxPolicy = policyFromMode(
      this.session.metadata.permissionMode ?? "read-only",
      this.cwd,
    );
    // Cost tracker. v0 defaults to "local" (which has $0 pricing);
    // F7.2+ adapters set the model name in their ModelResponse, so
    // cost is attributed per-response rather than per-construction.
    this.costTracker = new CostTracker({ model: "local" });
  }

  /** The AbortSignal tools see in their context. */
  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Abort the agent. The current iteration finishes (we don't
   * interrupt in-flight model calls), but the loop exits before
   * the next one starts. Tools in flight see their `abortSignal`
   * fire.
   */
  abort(reason?: unknown): void {
    this.abortController.abort(reason);
  }

  /**
   * F17.2: replace the model adapter. Takes effect on the next
   * `agent.run()` call. The current turn (if any) finishes with
   * the old model.
   *
   * **Why public:** the REPL's `/model` and `/provider` slash
   * commands need to swap models mid-session without rebuilding
   * the Agent (and re-discovering AGENTS.md / re-registering
   * hooks). The swap is just a field replacement; no other
   * state depends on the model's identity.
   *
   * **Cost tracking:** the cost tracker is keyed by the
   * `response.model` field that each adapter populates, NOT
   * by the adapter's identity. So a model swap doesn't
   * require touching the cost tracker — the next response
   * carries the new model's name.
   */
  setModel(model: ModelAdapter): void {
    this.model = model;
  }

  /**
   * F17.5: read-only access to the current model adapter.
   * The `/init` REPL command uses this to fire a one-shot
   * model call without going through `agent.run` (which
   * would pollute the main session transcript).
   *
   * **Why public:** the REPL's slash commands need to
   * invoke the model outside the agent loop (e.g. for
   * `AGENTS.md` generation). Exposing `getModel()` keeps
   * the adapter identity encapsulated while letting
   * commands fire their own `complete()` calls.
   */
  getModel(): ModelAdapter {
    return this.model;
  }

  /**
   * F17.6: read-only access to the mesh submitter (when
   * one is configured). The REPL's `/agents` command uses
   * this to read the sub-agent registry.
   *
   * **Why public:** the REPL's loop builds the agent
   * internally; it doesn't have the submitter reference
   * to pass to commands. Exposing `getMeshSubmitter()`
   * lets the loop extract the submitter (when present)
   * and wire it into `ReplContext.subagentRegistry`.
   *
   * **Why read-only:** the submitter is a per-Agent
   * configuration; commands must NOT swap it mid-run.
   * If a host needs to swap submitters, they construct
   * a new `Agent`.
   *
   * **Returns `undefined` when no submitter is
   * configured** (the agent has no `task` tool; the
   * `/agents` command should print "no sub-agents
   * configured" in that case).
   */
  getMeshSubmitter(): MeshSubmitter | undefined {
    return this.meshSubmitter;
  }

  /**
   * F17.2: replace the per-call approval handler. Takes effect
   * on the next tool call. Pass `undefined` to remove the
   * handler (the agent falls back to the default deny behavior).
   */
  setAskHandler(handler: AskHandler | undefined): void {
    this.askHandler = handler;
  }

  /**
   * F17.2: change the permission mode. Rebuilds the
   * `sandboxPolicy` from the new mode + the agent's cwd. The
   * next tool call (e.g. `bash`) sees the new policy.
   *
   * **Note:** the session's `metadata.permissionMode` is
   * immutable (it's `readonly` per the Session contract). We
   * don't update the session — we just rebuild the local
   * `sandboxPolicy`. The session's metadata reflects the
   * mode at session start; the running policy reflects the
   * current mode.
   */
  setPermissionMode(
    mode: NonNullable<Session["metadata"]["permissionMode"]>,
  ): void {
    this.sandboxPolicy = policyFromMode(mode, this.cwd);
  }

  /**
   * F-fix: the current effective permission mode (the live
   * policy, which `/sandbox` can change after session start).
   * Used by the REPL's `/init` to refuse writes in read-only
   * sessions.
   */
  getPermissionMode(): PermissionMode {
    return this.sandboxPolicy.mode;
  }

  /**
   * F17.2: clear the session transcript. The next turn starts
   * with a clean transcript; the agent's tools, hooks, and
   * AGENTS.md are preserved.
   */
  clearSession(): void {
    this.session.clear();
  }

  /**
   * F17.5: compact the session by dropping the oldest
   * messages, keeping the last `keep` messages. The system
   * message (if present) is always preserved at the
   * start of the session.
   *
   * **v0 limitation:** this is the "drop oldest" version
   * (truncation). A future chunk can add LLM-based
   * summarization (replace the dropped messages with a
   * summary block that the LLM generates).
   *
   * **Why public:** the REPL's `/compact` slash command
   * uses this when the transcript gets long. The host
   * (Tauri app) can also wire it to a manual button.
   */
  compact(keep: number): void {
    const messages = this.session.messages;
    if (messages.length <= keep) {
      // Nothing to compact.
      return;
    }
    // Find the system message (always at the start in v0
    // per agent.run's logic; if present, preserve it).
    const hasSystem = messages.length > 0 && messages[0]?.role === "system";
    const systemMsg = hasSystem ? messages[0] : undefined;
    const restMessages = messages.slice(hasSystem ? 1 : 0);
    // Keep the last `keep` of the non-system messages.
    const toKeep = restMessages.slice(-keep);
    // Clear + re-append.
    this.session.clear();
    if (systemMsg) {
      this.session.appendMessage("system", systemMsg.content);
    }
    for (const m of toKeep) {
      this.session.appendMessage(m.role, m.content);
    }
  }

  /**
   * F17.5: rebuild the session with a new id. The current
   * session is replaced by a fresh `InMemorySession`; the
   * transcript is gone (start from scratch). The agent's
   * tools, hooks, model, and AGENTS.md are preserved.
   *
   * **Why public:** the REPL's `/new` command needs to start
   * a fresh session without rebuilding the whole agent
   * (the user might have set a custom model, sandbox, hooks).
   *
   * **Why a new id:** the session id is the audit-trail key.
   * A new id makes the boundary between "old session" and
   * "new session" explicit in logs.
   */
  newSession(): void {
    this.session = new InMemorySession(newSessionId(), {
      cwd: this.cwd,
      // Preserve the LIVE policy mode (the `/sandbox` command may
      // have changed it after session start).
      permissionMode: this.sandboxPolicy.mode,
      startedAt: new Date().toISOString(),
      title: "repl",
    });
  }

  /**
   * F17.2: snapshot of the cost tracker's current totals.
   * Used by `/cost` to print accumulated spend + tokens.
   */
  getCost(): { costUsd: number; inputTokens: number; outputTokens: number } {
    return this.costTracker.total();
  }

  /**
   * F17.2.5: the session id. Used by `/session` to print
   * the current session's id (useful for log correlation
   * + resume).
   */
  getSessionId(): string {
    return this.session.id;
  }

  /**
   * F14.1: set the session's display title. Persisted
   * implementations (`PersistedSession`) write through to
   * disk so the title survives a `--resume`.
   */
  setTitle(title: string): void {
    this.session.setTitle(title);
  }

  /**
   * F17.2.5: the message count of the current session.
   * Used by `/context` to print the transcript size.
   */
  getMessageCount(): number {
    return this.session.messages.length;
  }

  /**
   * F17.2.5: snapshot of LSP servers registered with the
   * `lspManager` (when one is configured). Returns an
   * empty array when no `lspManager` is set.
   *
   * The shape is intentionally minimal: just the
   * language and rootUri per server. The 4 LSP tools
   * (lsp_definition, lsp_references, lsp_hover,
   * lsp_diagnostics) do the actual work; this is just
   * for the `/lsp` slash command.
   */
  getLspServers(): ReadonlyArray<{ language: string; rootUri: string }> {
    if (!this.lspManager) return [];
    return this.lspManager.listServers();
  }

  /**
   * F17.2.5: snapshot of registered hooks. Returns the
   * event name + handler count per event. Used by `/hooks`.
   */
  getHooks(): ReadonlyArray<{ event: string; handlerCount: number }> {
    return this.hooks.list();
  }

  /**
   * Run the agent loop with the given prompt. Returns the final
   * assistant content blocks and metadata about the run.
   *
   * **Side effects:** appends user / assistant / tool messages
   * to the session. Reads from the model and executes tools.
   * Fires PreToolUse and PostToolUse hooks.
   *
   * **Throws:** only on `maxIterations` exhaustion. All other
   * failures (tool errors, unknown tools, invalid args) become
   * `isError: true` tool results in the transcript.
   */
  async run(prompt: string): Promise<AgentResult> {
    // System prompt goes first (idempotent: skip if a system
    // message is already present).
    if (this.systemPrompt && !this.session.messages.some((m) => m.role === "system")) {
      this.session.appendMessage("system", [
        { type: "text", text: this.systemPrompt },
      ]);
    }
    this.session.appendMessage("user", [{ type: "text", text: prompt }]);

    // F9.4: emit agent_start. The model name is the best
    // guess we have (the agent doesn't know which model
    // the adapter will use until the first call returns
    // `usage.model`; for v0 we read it from the cost
    // tracker after each response — the start event uses
    // a placeholder "unknown" if unset).
    this.emit({
      kind: "agent_start",
      ts: new Date().toISOString(),
      sessionId: this.session.id,
      model: this.costTracker.currentModel,
      cwd: this.cwd,
      tools: this.tools.list().map((t) => t.name),
    });

    let iterations = 0;
    while (iterations < this.maxIterations) {
      if (this.abortController.signal.aborted) {
        return this.makeResult([], "aborted", iterations);
      }
      iterations++;

      // 1. Call the model.
      let response: ModelResponse;
      try {
        response = await this.model.complete({
          messages: this.session.messages,
          tools: this.tools.list(),
          signal: this.abortController.signal,
        });
      } catch (err) {
        // Model errors are surfaced as a synthetic assistant
        // message so the user sees the error in the transcript
        // and the loop exits cleanly (no retry policy in v0).
        const message = (err as Error).message ?? String(err);
        this.emit({
          kind: "error",
          ts: new Date().toISOString(),
          iteration: iterations,
          message: `model error: ${message}`,
        });
        this.session.appendMessage("assistant", [
          { type: "text", text: `[model error] ${message}` },
        ]);
        return this.makeResult(
          [{ type: "text", text: `[model error] ${message}` }],
          "aborted",
          iterations,
        );
      }

      // 1b. F7.1: cost attribution. The model reports usage; the
      // Agent attributes it to the right model (each model has
      // its own price). Unknown model + missing usage = 0 cost
      // (graceful default for FakeModel / local).
      if (response.usage) {
        this.costTracker.addUsage(
          {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
          },
          response.model,
        );
      }

      // 1c. F7.5: cost cap. After every usage attribution, check
      // against the cap. The cap is checked DURING the run, not
      // at the end — that's the whole point of a cap. Abort
      // cleanly; the result still has the cost up to this point.
      if (this.maxCostUsd !== undefined) {
        const total = this.costTracker.total();
        if (total.costUsd > this.maxCostUsd) {
          const reason = `max-cost-usd exceeded: $${total.costUsd.toFixed(4)} > $${this.maxCostUsd}`;
          this.abortController.abort(reason);
          // Surface the abort reason in the transcript AND the
          // result content so the model/user sees why the run
          // stopped (v0 omitted this — the user saw a silent
          // "aborted" stop reason with the last response text).
          const note: ContentBlock = {
            type: "text",
            text: `\n\n[aborted] ${reason}`,
          };
          this.session.appendMessage("assistant", [note]);
          return this.makeResult(
            [...response.content, note],
            "aborted",
            iterations,
          );
        }
      }

      // F9.4: emit model_response (after cost attribution
      // so the event matches what the agent saw).
      this.emit({
        kind: "model_response",
        ts: new Date().toISOString(),
        iteration: iterations,
        stopReason: response.stopReason,
        content: response.content,
        ...(response.usage ? { usage: response.usage } : {}),
      });

      // 2. Append the assistant message.
      this.session.appendMessage("assistant", response.content);

      // 3. Extract tool calls.
      const toolCalls = response.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_call" }> =>
          b.type === "tool_call",
      );

      // 4. No tool calls → done.
      if (toolCalls.length === 0) {
        return this.makeResult(
          response.content,
          normalizeStopReason(response.stopReason),
          iterations,
        );
      }

      // 5. Execute the tool calls. F10.2: when
      // ALL the calls are `task` (sub-agents),
      // run them in parallel — each sub-agent
      // gets its own session with no shared
      // state, so there's nothing to order by.
      // Mixed iterations (some `task` + some
      // `bash`) stay serial (bash is
      // order-dependent). The model's pattern
      // is the driver; the host doesn't opt in.
      await this.executeToolCalls(toolCalls, iterations);

      // If model said "max_tokens" and we have tool calls, treat
      // as end-of-turn; the agent shouldn't loop on a truncated
      // response. The transcript still has the tool results, so
      // a follow-up `run()` would see them.
      if (response.stopReason === "max_tokens") {
        return this.makeResult(response.content, "max_tokens", iterations);
      }
    }

    throw new Error(
      `agent loop exceeded max iterations (${this.maxIterations})`,
    );
  }

  /**
   * Run a single tool call through the full pipeline: hook
   * check, arg validation, execution, post-hook, transcript.
   * Errors are caught and turned into `isError: true` results.
   */
  /**
   * F10.2: execute a batch of tool calls. When
   * EVERY call is the `task` tool (sub-agent
   * fan-out) AND a `meshSubmitter` is configured,
   * run them in parallel via `Promise.all`.
   * Otherwise, run them serially in the order
   * they appear in the model's response.
   *
   * **Why auto-detect, not opt-in:** the model
   * is the driver. When the model emits N
   * `task` calls in one iteration, the right
   * behavior is to run them in parallel (each
   * sub-agent has its own session; nothing to
   * order by). When the model emits a mix
   * (e.g. `task` + `bash`), serial is the safe
   * default (bash is order-dependent).
   *
   * **Cap:** when the call count exceeds
   * `maxSubagents`, ALL calls are refused
   * (one `isError: true` tool_result per
   * call) with a clear message. Refusing all
   * teaches the model to budget sub-agents;
   * partial runs would hide the constraint.
   *
   * **Abort:** every in-flight sub-agent sees
   * the parent's abort signal on the next
   * iteration boundary (wired in F10.1.2's
   * `LocalMeshSubmitter`). `Promise.all` honors
   * the same signal; no extra wiring.
   *
   * **Result order:** the `tool_result` block
   * lands in completion order, not call order.
   * The model matches results to calls via
   * `toolCallId` (the standard tool-use
   * convention).
   */
  private async executeToolCalls(
    calls: ReadonlyArray<Extract<ContentBlock, { type: "tool_call" }>>,
    iteration: number,
  ): Promise<void> {
    if (calls.length === 0) return;

    // Sub-agent fan-out: parallel when ALL calls
    // are `task`. Other tools (bash, lsp_*, etc.)
    // may have order dependencies; they stay
    // serial.
    const allTask = this.meshSubmitter !== undefined &&
      calls.every((c) => c.name === "task");
    if (allTask) {
      // Cap check: refuse ALL when exceeded.
      if (calls.length > this.maxSubagents) {
        for (const call of calls) {
          this.appendToolResult(
            call.id,
            `maxSubagents reached: ${calls.length} task calls in one turn (cap is ${this.maxSubagents}). Refused.`,
            true,
          );
        }
        return;
      }
      // Parallel run. Each sub-agent runs in its
      // own session; abort propagation is wired
      // via the submitter (F10.1.2).
      await Promise.all(
        calls.map((call) => this.executeToolCall(call, iteration)),
      );
      return;
    }

    // Serial run (existing path). Used when:
    // - No meshSubmitter (no `task` tool at all)
    // - Mixed iteration (some `task` + some
    //   other tool that may have order
    //   dependencies)
    for (const call of calls) {
      if (this.abortController.signal.aborted) break;
      await this.executeToolCall(call, iteration);
    }
  }

  private async executeToolCall(
    call: Extract<ContentBlock, { type: "tool_call" }>,
    iteration: number,
  ): Promise<void> {
    this.toolCallCount++;
    const tool = this.tools.get(call.name);

    // PreToolUse hook (audit log, rate limit, block, ask).
    const preDecision = await this.firePreToolUse(call);
    if (preDecision.kind === "block") {
      this.emit({
        kind: "tool_call",
        ts: new Date().toISOString(),
        iteration,
        call,
      });
      this.appendToolResult(call.id, `blocked by PreToolUse: ${preDecision.reason}`, true);
      this.emit({
        kind: "tool_result",
        ts: new Date().toISOString(),
        iteration,
        callId: call.id,
        result: {
          content: `blocked by PreToolUse: ${preDecision.reason}`,
          isError: true,
        },
        durationMs: 0,
      });
      return;
    }

    // F9.1: per-call approval. The hook wants the host
    // to approve. We call the host's handler (if any)
    // and act on the decision. No handler → safe deny.
    if (preDecision.kind === "ask") {
      // Approval mode `never` fails closed regardless of any
      // host-installed askHandler.
      if (this.approval === "never") {
        this.emit({
          kind: "tool_call",
          ts: new Date().toISOString(),
          iteration,
          call,
        });
        const denial = `denied: approval mode is 'never' (${preDecision.question})`;
        this.appendToolResult(
          call.id,
          denial,
          true,
        );
        this.emit({
          kind: "tool_result",
          ts: new Date().toISOString(),
          iteration,
          callId: call.id,
          result: { content: denial, isError: true },
          durationMs: 0,
        });
        return;
      }
      const askReq: AskRequest = {
        tool: call.name,
        args: call.args,
        question: preDecision.question,
        ...(preDecision.options ? { options: preDecision.options } : {}),
        signal: this.abortController.signal,
      };
      const decision = this.askHandler
        ? await this.askHandler(askReq)
        : { kind: "deny" as const, reason: "no ask handler configured" };
      if (decision.kind === "deny") {
        this.emit({
          kind: "tool_call",
          ts: new Date().toISOString(),
          iteration,
          call,
        });
        const denial = `denied by user: ${decision.reason}`;
        this.appendToolResult(
          call.id,
          denial,
          true,
        );
        this.emit({
          kind: "tool_result",
          ts: new Date().toISOString(),
          iteration,
          callId: call.id,
          result: { content: denial, isError: true },
          durationMs: 0,
        });
        return;
      }
      if (decision.kind === "modify") {
        // Replace the args. We'll re-validate below
        // against the tool's zod schema.
        call = { ...call, args: decision.args };
      }
      // decision.kind === "allow" → fall through to
      // the tool runner.
    }

    // PreToolUse modify: the hook changed the tool call's args.
    // We re-validate against the tool's zod schema below.
    if (preDecision.kind === "modify") {
      call = { ...call, args: preDecision.modified };
    }

    if (!tool) {
      // F9.4: emit tool_call + tool_result even for
      // unknown tools (the trace records the attempt
      // + the error). Without this, an unknown tool
      // is invisible in the trace.
      this.emit({
        kind: "tool_call",
        ts: new Date().toISOString(),
        iteration,
        call,
      });
      this.appendToolResult(call.id, `unknown tool: ${call.name}`, true);
      this.emit({
        kind: "tool_result",
        ts: new Date().toISOString(),
        iteration,
        callId: call.id,
        result: { content: `unknown tool: ${call.name}`, isError: true },
        durationMs: 0,
      });
      return;
    }

    // F9.4: emit tool_call (after the PreToolUse hook
    // passes but BEFORE arg validation). The model can
    // see the call in the next iteration; the trace
    // gets it now. Even if arg validation fails, the
    // trace records the attempt.
    this.emit({
      kind: "tool_call",
      ts: new Date().toISOString(),
      iteration,
      call,
    });

    // Arg validation. Re-runs for the `modify` case
    // (the host may have given us a different shape).
    const parsed = tool.parameters.safeParse(call.args);
    if (!parsed.success) {
      this.appendToolResult(
        call.id,
        `invalid arguments: ${parsed.error.message}`,
        true,
      );
      this.emit({
        kind: "tool_result",
        ts: new Date().toISOString(),
        iteration,
        callId: call.id,
        result: {
          content: `invalid arguments: ${parsed.error.message}`,
          isError: true,
        },
        durationMs: 0,
      });
      return;
    }

    // Execute. Errors are caught — the model needs to see them.
    let resultContent: unknown;
    let isError = false;
    // F9.4: track tool execution duration for the
    // tool_result event. The timer starts AFTER arg
    // validation (we don't want to count time spent
    // in the hook / validation; the trace is for
    // tool execution time).
    const toolStart = Date.now();

    try {
      const result = await tool.execute(parsed.data, {
        cwd: this.cwd,
        session: this.session,
        abortSignal: this.abortController.signal,
        // Pass the live policy so the bash tool enforces the
        // current mode, not the session-start mode.
        sandboxPolicy: this.sandboxPolicy,
      });
      resultContent = result.content;
      isError = result.isError ?? false;
    } catch (err) {
      resultContent = `tool execution error: ${(err as Error).message}`;
      isError = true;
    }

    // F9.4: emit tool_result (after execution, before
    // post-hook / transcript append). The duration
    // is the time spent in the tool's `execute`.
    const toolDurationMs = Date.now() - toolStart;
    this.emit({
      kind: "tool_result",
      ts: new Date().toISOString(),
      iteration,
      callId: call.id,
      result: { content: resultContent, ...(isError ? { isError } : {}) },
      durationMs: toolDurationMs,
    });

    // PostToolUse hook (modify the result, add context).
    const postDecision = await this.firePostToolUse(call, {
      content: resultContent,
      isError,
    });
    if (postDecision.kind === "modify") {
      // The hook returned a new result. We treat it as opaque
      // (the hook is the source of truth for the new shape).
      const m = postDecision.modified as { content?: unknown; isError?: boolean } | undefined;
      if (m && typeof m === "object") {
        resultContent = m.content ?? resultContent;
        isError = m.isError ?? isError;
      } else {
        resultContent = postDecision.modified;
      }
    }
    this.appendToolResult(call.id, resultContent, isError);
  }

  private appendToolResult(
    toolCallId: string,
    content: unknown,
    isError: boolean,
  ): void {
    this.session.appendMessage("tool", [
      { type: "tool_result", toolCallId, content, isError },
    ]);
  }

  private async firePreToolUse(
    call: Extract<ContentBlock, { type: "tool_call" }>,
  ): Promise<HookDecision> {
    return this.hooks.fire("PreToolUse", {
      tool: call.name,
      args: call.args,
    });
  }

  private async firePostToolUse(
    call: Extract<ContentBlock, { type: "tool_call" }>,
    result: { content: unknown; isError: boolean },
  ): Promise<HookDecision> {
    return this.hooks.fire("PostToolUse", {
      tool: call.name,
      args: call.args,
      result,
    });
  }

  /**
   * F10.6: emit a trace event, automatically tagging
   * it with `subagentOf` (when this agent is a
   * sub-agent). Centralizes the `subagentOf`
   * propagation so every emit call site can't
   * forget it.
   *
   * **Why a helper, not `...event, subagentOf` at
   * each call site:** 9 emit calls in this file.
   * A helper keeps the field consistent (one place
   * to change) and avoids the "I forgot to add
   * `subagentOf`" bug.
   *
   * **What the consumer sees:** every event from a
   * sub-agent carries `subagentOf: <parentSessionId>`.
   * The parent tracer can group/filter by
   * `subagentOf` without inferring from event
   * ordering. Existing consumers (F9.4
   * `JsonLinesTracer`, the CLI's `--json` flag)
   * ignore the field.
   */
  private emit(event: import("./trace/index.js").TraceEvent): void {
    if (this.subagentOf !== undefined) {
      this.tracer.emit({ ...event, subagentOf: this.subagentOf });
    } else {
      this.tracer.emit(event);
    }
  }

  /** Build an `AgentResult` populated with the loop's metadata. */
  private makeResult(
    content: ContentBlock[],
    stopReason: AgentResult["stopReason"],
    iterations: number,
  ): AgentResult {
    const cost = this.costTracker.total();
    // F9.4: emit agent_end. This is the last event
    // the tracer sees; consumers (e.g. the CLI's
    // --json flag) can use it to flush.
    this.emit({
      kind: "agent_end",
      ts: new Date().toISOString(),
      stopReason,
      iterations,
      toolCalls: this.toolCallCount,
      metrics: {
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        costUsd: cost.costUsd,
      },
    });
    return {
      content,
      stopReason,
      iterations,
      toolCalls: this.toolCallCount,
      messages: this.session.messages,
      sandboxPolicy: this.sandboxPolicy,
      metrics: {
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        costUsd: cost.costUsd,
      },
    };
  }
}

/**
 * Normalize the model's `stopReason` into our `AgentResult` union.
 * `tool_use` from the model means "I want to call a tool"; we
 * keep that semantic so callers can distinguish "I just want to
 * call one tool" from "I'm done talking".
 */
function normalizeStopReason(
  modelReason: ModelResponse["stopReason"],
): AgentResult["stopReason"] {
  return modelReason;
}
