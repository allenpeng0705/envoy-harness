/**
 * MCP tool-call routing.
 *
 * Extracted from `tool-executor.ts` (CI module-size cap). MCP tools do
 * not fit the `Tool` interface — no zod schema, no cost, and the call is
 * async JSON-RPC over a child process — so they take a dedicated branch
 * rather than a fake `Tool` shim. Behaviour is unchanged.
 */
import type { ContentBlock } from "../tools/types.js";
import type { McpClientRegistry } from "../mcp/index.js";
import type { ToolResultSink } from "./tool-scheduler.js";

export interface McpCallDeps {
  readonly mcpClients: McpClientRegistry | undefined;
  readonly emit: (event: import("../trace/index.js").TraceEvent) => void;
  readonly commit: ToolResultSink;
  readonly firePostToolUse: (
    call: Extract<ContentBlock, { type: "tool_call" }>,
    result: { content: unknown; isError: boolean },
  ) => Promise<import("../hooks/index.js").HookDecision>;
  readonly emitToolOutput?: (info: {
    toolName: string;
    callId: string;
    stdout: string;
  }) => void;
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
  export async function executeMcpCall(
  call: Extract<ContentBlock, { type: "tool_call" }>,
  iteration: number,
  deps: McpCallDeps,
): Promise<void> {
  const { commit } = deps;
    const { parseMcpToolName } = await import("../mcp/types.js");
    const parsed = parseMcpToolName(call.name);
    if (parsed === null) {
      commit(
        call.id,
        `invalid MCP tool name: ${call.name}`,
        true,
      );
      return;
    }
    const registry = deps.mcpClients;
    if (registry === undefined) {
      commit(
        call.id,
        `MCP server not registered: ${parsed.serverName} (no McpClientRegistry configured)`,
        true,
      );
      return;
    }
    const client = registry.get(parsed.serverName);
    if (client === undefined) {
      commit(
        call.id,
        `MCP server not registered: ${parsed.serverName}`,
        true,
      );
      return;
    }

    // F9.4: emit tool_call (the model sees the call
    // in its next turn; the trace records it).
    deps.emit({
      kind: "tool_call",
      ts: new Date().toISOString(),
      iteration,
      call,
    });

    const toolStart = Date.now();
    let resultContent: unknown;
    let isError = false;
    try {
      const mcpResult = await client.callTool(
        parsed.toolName,
        call.args,
        deps.emitToolOutput !== undefined
          ? {
              onProgress: (text) =>
                deps.emitToolOutput!({
                  toolName: call.name,
                  callId: call.id,
                  stdout: text,
                }),
            }
          : undefined,
      );
      resultContent = mcpResult.content;
      isError = mcpResult.isError ?? false;
    } catch (err) {
      resultContent = `MCP tool error: ${(err as Error).message}`;
      isError = true;
    }

    const toolDurationMs = Date.now() - toolStart;
    deps.emit({
      kind: "tool_result",
      ts: new Date().toISOString(),
      iteration,
      callId: call.id,
      toolName: call.name,
      result: { content: resultContent, ...(isError ? { isError } : {}) },
      durationMs: toolDurationMs,
    });

    // PostToolUse hook (same as regular tools).
    const postDecision = await deps.firePostToolUse(call, {
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
    commit(call.id, resultContent, isError);
  }
