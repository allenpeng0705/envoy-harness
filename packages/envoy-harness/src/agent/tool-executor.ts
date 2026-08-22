/**
 * ToolExecutor — the per-tool-call execution seam
 * extracted from `agent.ts` in T2.3.
 *
 * **What it does (per design §3.4 step 5):**
 * 1. Fire `PreToolUse` hook; abort on `block`.
 * 2. If the hook returned `ask`, call the host's
 *    `askHandler`; on `deny` abort; on `modify`
 *    replace the args.
 * 3. Validate args against the tool's zod schema.
 * 4. Execute the tool. Catch errors → `isError: true`.
 * 5. Emit `tool_call` + `tool_result` trace events.
 * 6. Fire `PostToolUse` hook; honor `modify`.
 * 7. Append the `tool_result` to the session.
 *
 * **Why a separate class (T2.3 + T3.1 plan):** the
 * agent loop's `executeToolCall` is ~220 lines and
 * the only seam in the loop that needs to be
 * reachable from a mesh-side hook surface (the
 * F10.3+ RemoteMeshSubmitter runs the same flow
 * for sub-agents, but today the code is inlined
 * inside Agent). Extracting the class makes:
 * - the unit test surface smaller (a ToolExecutor
 *   can be tested in isolation with a fake context;
 *   today the test goes through Agent)
 * - the seam explicit (the host / mesh can replace
 *   or wrap the executor without forking Agent)
 * - T3.1's full `agent.ts` split (ToolExecutor +
 *   RunState + facade) easier — the executor
 *   already lives in its own file
 *
 * **Pure refactor:** no behavior change. The Agent
 * keeps the same public API; the private methods
 * are now on ToolExecutor and called via the
 * instance.
 */
import type { HookDecision } from "../hooks/index.js";
import type { Session } from "../session.js";
import type { ContentBlock, ToolRegistry } from "../tools/index.js";
import type {
  AskForApproval,
  AskHandler,
  AskRequest,
  SandboxPolicy,
} from "../types.js";
import type { SandboxExecutor } from "../sandbox/types.js";
import type { TraceEvent } from "../trace/index.js";
import type { MeshSubmitter } from "../subagent/index.js";
// T3.12: import the constant rather than hardcoding
// the `"mcp__"` prefix literal in the routing check
// (the audit-pass #2 finding). If MCP_TOOL_PREFIX
// ever changes, the routing check stays in sync
// with the name-construction in run-loop.ts:115.
import { MCP_TOOL_PREFIX } from "../mcp/types.js";

/**
 * The dependencies ToolExecutor reads from the
 * owning Agent. Held by reference (readonly); the
 * Agent mutates them in place (e.g. counters).
 *
 * **Why a context interface, not the Agent itself:**
 * passing `Agent` would create a circular import
 * and would let the executor reach into agent
 * internals it shouldn't (cost tracking, the
 * result builder, etc.). The context is the
 * narrowest possible seam.
 *
 * **Why some fields are getter functions, not values:**
 * `sandboxPolicy`, `approval`, and `askHandler` can
 * change at runtime (the REPL's `/sandbox`,
 * `/approval`, and a future `/askHandler` slash
 * command). The context holds getter functions
 * so the executor always reads the LIVE value,
 * not a stale snapshot from construction time.
 * The other fields are set once and don't change
 * during the agent's lifetime.
 */
export interface ToolExecutorContext {
  /** The hook registry. Pre/PostToolUse fire here. */
  readonly hooks: {
    fire(event: "PreToolUse", payload: unknown): Promise<HookDecision>;
    fire(
      event: "PostToolUse",
      payload: unknown,
    ): Promise<HookDecision>;
  };
  /** The tool registry. The executor looks up tools by name. */
  readonly tools: ToolRegistry;
  /** The session. The executor appends `tool_result` messages. */
  readonly session: Session;
  /** The cwd. Passed to the tool's `ToolContext`. */
  readonly cwd: string;
  /**
   * The live sandbox policy. Read at call time so
   * `/sandbox workspace-write` takes effect on the
   * next tool call (not "next agent construction").
   * The bash tool reads this.
   */
  readonly getSandboxPolicy: () => SandboxPolicy;
  /**
   * Phase F: live OS sandbox executor. Read at call
   * time so a host can swap backends without
   * reconstructing the agent. Bash uses this after
   * the 6 validators.
   */
  readonly getSandboxExecutor: () => SandboxExecutor | undefined;
  /**
   * The live ask handler. Read at call time so a
   * future host swap takes effect on the next ask.
   * For F9.1 per-call approval.
   */
  readonly getAskHandler: () => AskHandler | undefined;
  /**
   * The live approval mode. Read at call time so
   * `/approval never` takes effect on the next
   * tool call. `"never"` fails closed.
   */
  readonly getApproval: () => AskForApproval;
  /** Abort signal. The executor breaks out of the loop when aborted. */
  readonly abortSignal: AbortSignal;
  /** F10.2: cap on parallel sub-agent calls per turn. */
  readonly maxSubagents: number;
  /** F10.1: the mesh submitter. Drives the parallel-fan-out detection. */
  readonly meshSubmitter: MeshSubmitter | undefined;
  /**
   * T3.3: the MCP client registry. When a tool call's
   * name starts with `mcp__`, the executor routes it
   * to the matching client (parsed via
   * `parseMcpToolName`). When undefined, `mcp__*`
   * calls fail with "unknown tool" (the same as a
   * missing built-in tool).
   */
  readonly mcpClients: import("../mcp/index.js").McpClientRegistry | undefined;
  /**
   * Emit a trace event. The Agent's `emit` wraps the
   * tracer with the `subagentOf` tag; the executor
   * just calls back into the owner.
   */
  emit(event: TraceEvent): void;
  /**
   * Increment the per-`run` tool-call counter on the
   * owning Agent. Called once per `execute()`. The
   * counter is read by `Agent.makeResult` to populate
   * `AgentResult.toolCalls`.
   */
  noteToolCall(): void;
}

export class ToolExecutor {
  constructor(private readonly ctx: ToolExecutorContext) {}

  /**
   * Run a batch of tool calls. When ALL calls are
   * `task` (sub-agents) and a `meshSubmitter` is
   * configured, runs them in parallel; otherwise
   * runs them serially (so a `bash` call that
   * depends on a prior `task` result still works).
   *
   * **Cap:** when parallel + count > `maxSubagents`,
   * refuses ALL (every call gets an `isError: true`
   * result explaining the cap).
   *
   * **Abort:** the serial path checks `abortSignal`
   * between calls (Promise.all cannot interrupt).
   */
  async executeMany(
    calls: ReadonlyArray<Extract<ContentBlock, { type: "tool_call" }>>,
    iteration: number,
  ): Promise<void> {
    if (calls.length === 0) return;

    // Sub-agent fan-out: parallel when ALL calls are
    // `task`. Other tools (bash, lsp_*, etc.) may
    // have order dependencies; they stay serial.
    const allTask =
      this.ctx.meshSubmitter !== undefined &&
      calls.every((c) => c.name === "task");
    if (allTask) {
      // Cap check: refuse ALL when exceeded.
      if (calls.length > this.ctx.maxSubagents) {
        for (const call of calls) {
          this.appendToolResult(
            call.id,
            `maxSubagents reached: ${calls.length} task calls in one turn (cap is ${this.ctx.maxSubagents}). Refused.`,
            true,
          );
        }
        return;
      }
      // Parallel run. Each sub-agent runs in its
      // own session; abort propagation is wired
      // via the submitter (F10.1.2).
      await Promise.all(
        calls.map((call) => this.execute(call, iteration)),
      );
      return;
    }

    // Serial run (existing path). Used when:
    // - No meshSubmitter (no `task` tool at all)
    // - Mixed iteration (some `task` + some other
    //   tool that may have order dependencies)
    for (const call of calls) {
      if (this.ctx.abortSignal.aborted) break;
      await this.execute(call, iteration);
    }
  }

  /**
   * Run a single tool call. The 5-step flow is
   * documented at the top of this file.
   *
   * **Why this is a public method:** the parallel
   * fan-out path in `executeMany` calls it directly
   * (one per call). Tests in T3.1 may exercise it
   * in isolation.
   */
  async execute(
    call: Extract<ContentBlock, { type: "tool_call" }>,
    iteration: number,
  ): Promise<void> {
    this.ctx.noteToolCall();
    const tool = this.ctx.tools.get(call.name);

    // PreToolUse hook (audit log, rate limit, block, ask).
    const preDecision = await this.firePreToolUse(call);
    if (preDecision.kind === "block") {
      this.ctx.emit({
        kind: "tool_call",
        ts: new Date().toISOString(),
        iteration,
        call,
      });
      this.appendToolResult(call.id, `blocked by PreToolUse: ${preDecision.reason}`, true);
      this.ctx.emit({
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
      if (this.ctx.getApproval() === "never") {
        this.ctx.emit({
          kind: "tool_call",
          ts: new Date().toISOString(),
          iteration,
          call,
        });
        const denial = `denied: approval mode is 'never' (${preDecision.question})`;
        this.appendToolResult(call.id, denial, true);
        this.ctx.emit({
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
        signal: this.ctx.abortSignal,
      };
      const askHandler = this.ctx.getAskHandler();
      const decision = askHandler
        ? await askHandler(askReq)
        : { kind: "deny" as const, reason: "no ask handler configured" };
      // Host may have cancelled while the permission dialog was open.
      if (this.ctx.abortSignal.aborted) {
        this.ctx.emit({
          kind: "tool_call",
          ts: new Date().toISOString(),
          iteration,
          call,
        });
        const denial = "denied: cancelled while awaiting approval";
        this.appendToolResult(call.id, denial, true);
        this.ctx.emit({
          kind: "tool_result",
          ts: new Date().toISOString(),
          iteration,
          callId: call.id,
          result: { content: denial, isError: true },
          durationMs: 0,
        });
        return;
      }
      if (decision.kind === "deny") {
        this.ctx.emit({
          kind: "tool_call",
          ts: new Date().toISOString(),
          iteration,
          call,
        });
        const denial = `denied by user: ${decision.reason}`;
        this.appendToolResult(call.id, denial, true);
        this.ctx.emit({
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

    // T3.3 + T3.12: MCP routing. When the call name
    // starts with MCP_TOOL_PREFIX, route to the
    // matching client. Skips the built-in tool
    // lookup (the registry IS the authority for MCP
    // tools). Uses the constant (not the literal
    // "mcp__") so name-construction in
    // `run-loop.ts:115` + routing here stay in sync
    // if the prefix ever changes.
    if (call.name.startsWith(MCP_TOOL_PREFIX)) {
      await this.executeMcpCall(call, iteration);
      return;
    }

    if (!tool) {
      // F9.4: emit tool_call + tool_result even for
      // unknown tools (the trace records the attempt
      // + the error). Without this, an unknown tool
      // is invisible in the trace.
      this.ctx.emit({
        kind: "tool_call",
        ts: new Date().toISOString(),
        iteration,
        call,
      });
      this.appendToolResult(call.id, `unknown tool: ${call.name}`, true);
      this.ctx.emit({
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
    this.ctx.emit({
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
      this.ctx.emit({
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
      const sandboxExecutor = this.ctx.getSandboxExecutor();
      const result = await tool.execute(parsed.data, {
        cwd: this.ctx.cwd,
        session: this.ctx.session,
        abortSignal: this.ctx.abortSignal,
        // Pass the live policy so the bash tool enforces the
        // current mode, not the session-start mode.
        sandboxPolicy: this.ctx.getSandboxPolicy(),
        ...(sandboxExecutor !== undefined ? { sandboxExecutor } : {}),
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
    this.ctx.emit({
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
    this.ctx.session.appendMessage("tool", [
      { type: "tool_result", toolCallId, content, isError },
    ]);
  }

  private async firePreToolUse(
    call: Extract<ContentBlock, { type: "tool_call" }>,
  ): Promise<HookDecision> {
    return this.ctx.hooks.fire("PreToolUse", {
      tool: call.name,
      args: call.args,
    });
  }

  private async firePostToolUse(
    call: Extract<ContentBlock, { type: "tool_call" }>,
    result: { content: unknown; isError: boolean },
  ): Promise<HookDecision> {
    return this.ctx.hooks.fire("PostToolUse", {
      tool: call.name,
      args: call.args,
      result,
    });
  }

  /**
   * T3.3: route a single `mcp__*` tool call to the
   * matching client. Mirrors the regular `execute`
   * flow (PreToolUse already fired; PostToolUse +
   * tool_result append happen here; trace events
   * emitted). The MCP client owns the actual JSON-
   * RPC call.
   *
   * **Why in ToolExecutor, not in the ToolRegistry:**
   * MCP tools don't fit the `Tool` interface (no
   * `parameters` zod schema, no `costUsd`, the
   * execute call is async JSON-RPC over a child
   * process). A dedicated branch in the executor
   * is simpler than a fake `Tool` shim.
   */
  private async executeMcpCall(
    call: Extract<ContentBlock, { type: "tool_call" }>,
    iteration: number,
  ): Promise<void> {
    const { parseMcpToolName } = await import("../mcp/types.js");
    const parsed = parseMcpToolName(call.name);
    if (parsed === null) {
      this.appendToolResult(
        call.id,
        `invalid MCP tool name: ${call.name}`,
        true,
      );
      return;
    }
    const registry = this.ctx.mcpClients;
    if (registry === undefined) {
      this.appendToolResult(
        call.id,
        `MCP server not registered: ${parsed.serverName} (no McpClientRegistry configured)`,
        true,
      );
      return;
    }
    const client = registry.get(parsed.serverName);
    if (client === undefined) {
      this.appendToolResult(
        call.id,
        `MCP server not registered: ${parsed.serverName}`,
        true,
      );
      return;
    }

    // F9.4: emit tool_call (the model sees the call
    // in its next turn; the trace records it).
    this.ctx.emit({
      kind: "tool_call",
      ts: new Date().toISOString(),
      iteration,
      call,
    });

    const toolStart = Date.now();
    let resultContent: unknown;
    let isError = false;
    try {
      const mcpResult = await client.callTool(parsed.toolName, call.args);
      resultContent = mcpResult.content;
      isError = mcpResult.isError ?? false;
    } catch (err) {
      resultContent = `MCP tool error: ${(err as Error).message}`;
      isError = true;
    }

    const toolDurationMs = Date.now() - toolStart;
    this.ctx.emit({
      kind: "tool_result",
      ts: new Date().toISOString(),
      iteration,
      callId: call.id,
      result: { content: resultContent, ...(isError ? { isError } : {}) },
      durationMs: toolDurationMs,
    });

    // PostToolUse hook (same as regular tools).
    const postDecision = await this.firePostToolUse(call, {
      content: resultContent,
      isError,
    });
    if (postDecision.kind === "modify") {
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
}
