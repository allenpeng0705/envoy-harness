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
import { collaborationModeBlockReason } from "../plan/tool-policy.js";
import {
  durabilityToolRefusalMessage,
  ensureDurable,
} from "./durability.js";
import {
  fireNotification,
  firePermissionRequest,
  fireSubagentStop,
} from "../hooks/lifecycle.js";
import { executeMcpCall } from "./mcp-call.js";
import { runWithToolTimeout } from "./tool-timeout.js";
import { inferToolNameFromArgs } from "./tool-name-inference.js";
import {
  createToolCallSurfaces,
  type ToolCallSurfaces,
} from "./sandbox-escalation-wiring.js";
import type { ToolResultMeta } from "../tools/types.js";
import {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  runToolGroupInModelOrder,
  type ToolResultSink,
} from "./tool-scheduler.js";

// Re-exported so the public API keeps a single import path for hosts
// that already pull these from the executor module.
export {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  type PendingToolResult,
  type ToolResultSink,
} from "./tool-scheduler.js";
export { inferToolNameFromArgs } from "./tool-name-inference.js";

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
  /**
   * The hook firer. Any event may be fired from here — the context used
   * to narrow this to `PreToolUse`/`PostToolUse`, which is part of why
   * the other ten declared events had no fire site.
   */
  readonly hooks: import("../hooks/lifecycle.js").HookFirer;
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
  /**
   * Env map for bash/job spawns (after shell_environment_policy).
   * When omitted, tools fall back to process.env.
   */
  readonly getShellEnv?: () => Record<string, string>;
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
   * R4.14b — optional exec-world for FS/shell tools (peer-targeted).
   */
  readonly execWorld?: import("../exec-world/types.js").ExecWorld;
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
  /**
   * Forward live tool stdout to the protocol host (bash streaming).
   */
  emitToolOutput?: (info: {
    toolName: string;
    callId: string;
    stdout: string;
  }) => void;
  /** Record write/edit changes for `/undo`. */
  recordUndo?: (entry: {
    path: string;
    previousContent: string | null;
  }) => void;
  /**
   * Cap on tool calls running concurrently within one model turn.
   *
   * Only the all-`task` fan-out path is parallel today. This is a
   * *concurrency* cap, distinct from `maxSubagents` (a count cap that
   * refuses the whole batch). Optional so existing hosts keep working;
   * defaults to {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}.
   */
  getMaxParallelToolCalls?: () => number;
}


export class ToolExecutor {
  /**
   * The approval + diagnostics wiring for sandbox escalation.
   *
   * Built once in the constructor so the tool-call path stays a thin
   * delegation; the logic lives in `sandbox-escalation-wiring.ts` (this
   * file is already at the module-size ceiling).
   */
  private readonly escalation: ToolCallSurfaces;

  constructor(private readonly ctx: ToolExecutorContext) {
    this.escalation = createToolCallSurfaces({
      session: ctx.session,
      cwd: ctx.cwd,
      hooks: ctx.hooks,
      abortSignal: ctx.abortSignal,
      getSandboxPolicy: ctx.getSandboxPolicy,
      getSandboxExecutor: ctx.getSandboxExecutor,
      getApproval: ctx.getApproval,
      getAskHandler: ctx.getAskHandler,
      ...(ctx.getShellEnv !== undefined ? { getShellEnv: ctx.getShellEnv } : {}),
      ...(ctx.recordUndo !== undefined ? { recordUndo: ctx.recordUndo } : {}),
      ...(ctx.execWorld !== undefined ? { execWorld: ctx.execWorld } : {}),
    });
  }

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

    // Sub-agent fan-out: parallel when ALL calls are `task`. Other tools
    // (bash, lsp_*, etc.) may have order dependencies; they stay serial.
    const allTask =
      this.ctx.meshSubmitter !== undefined &&
      calls.every((c) => c.name === "task");
    if (!allTask) {
      for (const call of calls) {
        if (this.ctx.abortSignal.aborted) break;
        await this.execute(call, iteration);
      }
      return;
    }

    // Cap check: refuse ALL when exceeded (a count cap, not a
    // concurrency limit — see `getMaxParallelToolCalls`).
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

    await this.executeBoundedParallel(calls, iteration);
  }

  /**
   * Run `calls` with a bounded rolling pool, then commit every result
   * to the transcript **in model order**.
   *
   * The scheduling lives in `tool-scheduler.ts`; this method only wires
   * it to the executor (execute, commit, record a skipped call).
   */
  private async executeBoundedParallel(
    calls: ReadonlyArray<Extract<ContentBlock, { type: "tool_call" }>>,
    iteration: number,
  ): Promise<void> {
    await runToolGroupInModelOrder({
      calls,
      maxParallel:
        this.ctx.getMaxParallelToolCalls?.() ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS,
      signal: this.ctx.abortSignal,
      runOne: (call, sink) => this.execute(call, iteration, sink),
      commit: (result) =>
        this.appendToolResult(result.id, result.content, result.isError),
      onSkipped: (call) =>
        this.appendToolResult(
          call.id,
          "not executed: the turn was aborted before this call started",
          true,
        ),
    });
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
    sink?: ToolResultSink,
  ): Promise<void> {
    this.ctx.noteToolCall();
    // Commit target: the caller's sink (parallel batches collect, then
    // commit in model order) or the transcript directly.
    const commit: ToolResultSink =
      sink ??
      ((id, content, isError) => this.appendToolResult(id, content, isError));
    const isMcpCall = call.name.startsWith(MCP_TOOL_PREFIX);

    // Malformed model call (empty tool name): some OpenAI-compatible
    // providers (MiniMax, local llama-server) omit the tool name in the
    // response while still sending the args. Recover by inferring the
    // name from the args when EXACTLY ONE registered tool validates
    // them. Otherwise refuse WITHOUT the permission hook — a host must
    // never see "Allow tool ``?" for a call that cannot execute.
    if (call.name.trim().length === 0) {
      const inferred = inferToolNameFromArgs(this.ctx.tools, call.args);
      if (inferred !== undefined) {
        call = { ...call, name: inferred };
      } else {
        this.ctx.emit({
          kind: "tool_call",
          ts: new Date().toISOString(),
          iteration,
          call,
        });
        // Diagnostic: include the args + registered tool names so the
        // model (and the user) can see exactly what failed and what the
        // executor compared against. This also lets the model correct
        // its next call instead of looping blindly.
        const message = `tool call missing a tool name (args: ${JSON.stringify(
          call.args,
        )}; registered: ${this.ctx.tools
          .list()
          .map((t) => t.name)
          .join(", ")})`;
        commit(call.id, message, true);
        this.ctx.emit({
          kind: "tool_result",
          ts: new Date().toISOString(),
          iteration,
          callId: call.id,
          toolName: call.name,
          result: { content: message, isError: true },
          durationMs: 0,
        });
        return;
      }
    }
    const tool = this.ctx.tools.get(call.name);

    // R4.6 — collaboration mode hard-deny before hooks / execution.
    {
      const modeKind = this.ctx.session.getCollaborationMode().kind;
      const blocked = collaborationModeBlockReason(modeKind, call.name);
      if (blocked !== undefined) {
        this.ctx.emit({
          kind: "tool_call",
          ts: new Date().toISOString(),
          iteration,
          call,
        });
        commit(call.id, blocked, true);
        this.ctx.emit({
          kind: "tool_result",
          ts: new Date().toISOString(),
          iteration,
          callId: call.id,
          toolName: call.name,
          result: { content: blocked, isError: true },
          durationMs: 0,
        });
        return;
      }
    }

    // Unknown tool (not an MCP-routed call): surface the error directly
    // instead of pausing on a permission prompt for a tool that cannot
    // execute. The trace still records the attempt + error.
    if (!tool && !isMcpCall) {
      this.ctx.emit({
        kind: "tool_call",
        ts: new Date().toISOString(),
        iteration,
        call,
      });
      commit(call.id, `unknown tool: ${call.name}`, true);
      this.ctx.emit({
        kind: "tool_result",
        ts: new Date().toISOString(),
        iteration,
        callId: call.id,
        toolName: call.name,
        result: { content: `unknown tool: ${call.name}`, isError: true },
        durationMs: 0,
      });
      return;
    }

    // PreToolUse hook (audit log, rate limit, block, ask).
    const preDecision = await this.firePreToolUse(call);
    if (preDecision.kind === "block") {
      this.ctx.emit({
        kind: "tool_call",
        ts: new Date().toISOString(),
        iteration,
        call,
      });
      commit(call.id, `blocked by PreToolUse: ${preDecision.reason}`, true);
      this.ctx.emit({
        kind: "tool_result",
        ts: new Date().toISOString(),
        iteration,
        callId: call.id,
        toolName: call.name,
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
        commit(call.id, denial, true);
        this.ctx.emit({
          kind: "tool_result",
          ts: new Date().toISOString(),
          iteration,
          callId: call.id,
        toolName: call.name,
          result: { content: denial, isError: true },
          durationMs: 0,
        });
        return;
      }
      // `PermissionRequest`: a hook that knows this action is forbidden
      // should deny it outright rather than putting the question to a
      // human. `Notification` tells observers a decision is pending.
      const permission = await firePermissionRequest(this.ctx.hooks, {
        sessionId: this.ctx.session.id,
        tool: call.name,
        args: call.args,
        question: preDecision.question,
      });
      if (permission.blocked !== undefined) {
        commit(call.id, `blocked by PermissionRequest: ${permission.blocked}`, true);
        return;
      }
      await fireNotification(this.ctx.hooks, {
        sessionId: this.ctx.session.id,
        kind: "permission_request",
        message: preDecision.question,
      });

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
        commit(call.id, denial, true);
        this.ctx.emit({
          kind: "tool_result",
          ts: new Date().toISOString(),
          iteration,
          callId: call.id,
        toolName: call.name,
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
        commit(call.id, denial, true);
        this.ctx.emit({
          kind: "tool_result",
          ts: new Date().toISOString(),
          iteration,
          callId: call.id,
        toolName: call.name,
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
    // starts with MCP_TOOL_PREFIX AND the tool is not
    // registered in the ToolRegistry (the
    // `registerMcpTools` bridge), route to the matching
    // client directly. A registry-registered MCP tool
    // flows through the normal path so envoy's hooks,
    // arg validation, and permissions govern it.
    if (isMcpCall && tool === undefined) {
      await executeMcpCall(call, iteration, {
        mcpClients: this.ctx.mcpClients,
        emit: (event) => this.ctx.emit(event),
        commit,
        firePostToolUse: (c, r) => this.firePostToolUse(c, r),
        ...(this.ctx.emitToolOutput !== undefined
          ? { emitToolOutput: this.ctx.emitToolOutput }
          : {}),
      });
      return;
    }

    // Both the unknown-tool and MCP branches returned above, so `tool`
    // is guaranteed defined here. TS cannot narrow the compound
    // conditions, so capture it once.
    const registeredTool = tool as NonNullable<typeof tool>;

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
    const parsed = registeredTool.parameters.safeParse(call.args);
    if (!parsed.success) {
      commit(
        call.id,
        `invalid arguments: ${parsed.error.message}`,
        true,
      );
      this.ctx.emit({
        kind: "tool_result",
        ts: new Date().toISOString(),
        iteration,
        callId: call.id,
        toolName: call.name,
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
    /** Structured sandbox/escalation outcome reported by the tool. */
    let resultMeta: ToolResultMeta | undefined;
    // F9.4: track tool execution duration for the
    // tool_result event. The timer starts AFTER arg
    // validation (we don't want to count time spent
    // in the hook / validation; the trace is for
    // tool execution time).
    const toolStart = Date.now();

    // DURABILITY BARRIER. The `tool_call` was just appended; make it
    // durable BEFORE the body runs. A tool with side effects whose call
    // is not recorded can be re-executed after a crash, and the model
    // cannot be told the truth about what happened.
    {
      const durable = await ensureDurable(this.ctx.session);
      if (!durable.ok) {
        const refusal = durabilityToolRefusalMessage(durable.message);
        commit(call.id, refusal, true);
        this.ctx.emit({
          kind: "tool_result",
          ts: new Date().toISOString(),
          iteration,
          callId: call.id,
          toolName: call.name,
          result: { content: refusal, isError: true },
          durationMs: 0,
        });
        return;
      }
    }

    try {
      // Per-tool wall-clock budget. `read_file`/`write`/`edit`/`git`
      // declared none, so a stuck filesystem or a hung git could hang the
      // turn forever. See `tool-timeout.ts` for the cooperative-then-bounded
      // strategy.
      const timeoutOutcome = await runWithToolTimeout({
        timeoutMs: registeredTool.timeoutMs,
        signal: this.ctx.abortSignal,
        body: (toolSignal) =>
          registeredTool.execute(parsed.data, {
            ...this.escalation.buildToolContext(toolSignal),
            ...(this.ctx.emitToolOutput !== undefined
              ? {
                  onToolOutput: (stdout: string) =>
                    this.ctx.emitToolOutput!({
                      toolName: call.name,
                      callId: call.id,
                      stdout,
                    }),
                }
              : {}),
          }),
        onTimeout: ({ timeoutMs, abandoned }) => ({
          content: abandoned
            ? `tool timed out after ${timeoutMs}ms and did not respond to ` +
              "cancellation. It may STILL BE RUNNING — do not assume it had " +
              "no effect; verify external state before retrying."
            : `tool timed out after ${timeoutMs}ms`,
          isError: true,
        }),
      });
      resultContent = timeoutOutcome.result.content;
      isError = timeoutOutcome.result.isError ?? false;
      resultMeta = timeoutOutcome.result.meta;
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
      toolName: call.name,
      result: {
        content: resultContent,
        ...(isError ? { isError } : {}),
        ...(resultMeta !== undefined ? { meta: resultMeta } : {}),
      },
      durationMs: toolDurationMs,
    });
    // The prose above is for the model; this is the durable, switchable
    // record. A resumed session can then answer "was this turn ever
    // refused by the sandbox, and did the user widen it?" without a trace
    // stream (which is off by default).
    this.escalation.recordSandboxDiagnostics(iteration, call.name, resultMeta);

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
    // `SubagentStop`: a `task` call IS a sub-agent, and this is the one
    // boundary holding the PARENT's hook registry (the submitter only
    // knows its own sub-session). Fired once the result is final so the
    // hook observes the outcome that actually happened.
    if (call.name === "task") {
      await fireSubagentStop(this.ctx.hooks, {
        parentSessionId: this.ctx.session.id,
        // The submitter does not advertise a peer id on the base
        // interface; the result's own `workerPeerId` is authoritative
        // and travels in the result, so report the local default here.
        workerPeerId: "local",
        status: isError ? "failed" : "completed",
      });
    }

    commit(call.id, resultContent, isError);
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

}
