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
import type { ModelAdapter, ModelResponse } from "./model.js";
import type { Session } from "./session.js";
import type { ContentBlock, ToolRegistry } from "./tools/index.js";
import type { SandboxPolicy } from "./types.js";
import { CostTracker } from "./cost.js";

/** Default max iterations before the agent throws. */
export const DEFAULT_MAX_ITERATIONS = 50;

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

  constructor(options: AgentOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.session = options.session;
    this.hooks = options.hooks ?? defaultRegistry;
    this.cwd = options.cwd ?? process.cwd();
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
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
    // The bash tool re-derives this; here we use it for the verifier
    // and the AgentResult so callers can audit what was enforced.
    this.sandboxPolicy = policyFromSessionMode(
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
        });
      } catch (err) {
        // Model errors are surfaced as a synthetic assistant
        // message so the user sees the error in the transcript
        // and the loop exits cleanly (no retry policy in v0).
        const message = (err as Error).message ?? String(err);
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

      // 5. Execute each tool call (in order).
      for (const call of toolCalls) {
        if (this.abortController.signal.aborted) break;
        await this.executeToolCall(call);
      }

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
  private async executeToolCall(
    call: Extract<ContentBlock, { type: "tool_call" }>,
  ): Promise<void> {
    this.toolCallCount++;
    const tool = this.tools.get(call.name);

    // PreToolUse hook (audit log, rate limit, block).
    const preDecision = await this.firePreToolUse(call);
    if (preDecision.kind === "block") {
      this.appendToolResult(call.id, `blocked by PreToolUse: ${preDecision.reason}`, true);
      return;
    }

    if (!tool) {
      this.appendToolResult(call.id, `unknown tool: ${call.name}`, true);
      return;
    }

    // Arg validation.
    const parsed = tool.parameters.safeParse(call.args);
    if (!parsed.success) {
      this.appendToolResult(
        call.id,
        `invalid arguments: ${parsed.error.message}`,
        true,
      );
      return;
    }

    // Execute. Errors are caught — the model needs to see them.
    let resultContent: unknown;
    let isError = false;
    try {
      const result = await tool.execute(parsed.data, {
        cwd: this.cwd,
        session: this.session,
        abortSignal: this.abortController.signal,
      });
      resultContent = result.content;
      isError = result.isError ?? false;
    } catch (err) {
      resultContent = `tool execution error: ${(err as Error).message}`;
      isError = true;
    }

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

  /** Build an `AgentResult` populated with the loop's metadata. */
  private makeResult(
    content: ContentBlock[],
    stopReason: AgentResult["stopReason"],
    iterations: number,
  ): AgentResult {
    const cost = this.costTracker.total();
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

/**
 * Build a `SandboxPolicy` from a session's permission mode.
 * Same shape as the bash tool's `policyFromMode` — they MUST
 * stay in sync. If you change one, change the other. The
 * duplication exists because the agent needs the policy for
 * its result (verifier visibility) while the bash tool needs
 * it for validation. The two are computed independently and
 * compared at test time.
 */
function policyFromSessionMode(
  mode: NonNullable<Session["metadata"]["permissionMode"]>,
  cwd: string,
): SandboxPolicy {
  if (mode === "danger-full-access") {
    return {
      mode,
      approval: "never",
      backend: "none",
      writableRoots: [],
      networkAccess: true,
      excludeSlashTmp: true,
    };
  }
  return {
    mode,
    approval: "on-request",
    backend: "linux-landlock",
    writableRoots: mode === "workspace-write" ? [cwd] : [],
    networkAccess: false,
    excludeSlashTmp: true,
  };
}
