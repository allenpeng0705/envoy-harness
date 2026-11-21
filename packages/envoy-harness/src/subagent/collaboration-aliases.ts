/**
 * Gap 5 — Codex-shaped multi-agent V2 collaboration aliases.
 *
 * Thin wrappers over existing `task` / `send_message` / `wait_agents` /
 * `interrupt_agent` / `list_agents` / parent `wait_inbox`. No new lifecycle.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../tools/types.js";
import type { InboxContent } from "../agent/inbox.js";
import type { InboxTarget } from "../agent/inbox.js";

function toolByName(
  tools: ReadonlyArray<Tool>,
  name: string,
): Tool | undefined {
  return tools.find((t) => t.name === name);
}

async function delegate(
  tools: ReadonlyArray<Tool>,
  name: string,
  args: unknown,
  ctx: Parameters<Tool["execute"]>[1],
): Promise<ToolResult> {
  const t = toolByName(tools, name);
  if (t === undefined) {
    return {
      content: `collaboration alias: underlying tool '${name}' is not registered`,
      isError: true,
    };
  }
  return t.execute(args as never, ctx);
}

export interface MakeCollaborationAliasToolsOptions {
  /** Already-built task + control tools to delegate to. */
  underlying: ReadonlyArray<Tool>;
  /** Parent inbox activity wait (Gap 2). */
  waitInboxActivity: (opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<{ target: InboxTarget; content: InboxContent }>;
}

/**
 * Register when continuable submitter is available (same gate as control tools).
 */
export function makeCollaborationAliasTools(
  options: MakeCollaborationAliasToolsOptions,
): Tool[] {
  const { underlying, waitInboxActivity } = options;

  const spawnAgent: Tool = {
    name: "spawn_agent",
    description:
      "Codex-shaped alias for `task`: spawn a child agent. Prefer " +
      "run_in_background: true for steerable children. The child's " +
      "session id is its thread id for followup_task / wait_agent / close_agent.",
    parameters: z.object({}).passthrough(),
    isConcurrencySafe: () => true,
    async execute(args, ctx) {
      return delegate(underlying, "task", args, ctx);
    },
  };

  const followupTask: Tool = {
    name: "followup_task",
    description:
      "Codex-shaped alias for `send_message`: send follow-up input to a " +
      "continuable child (thread id = agent_id = child session id).",
    parameters: z.object({
      agent_id: z.string().min(1),
      message: z.string().min(1),
      delivery: z.enum(["queue", "trigger"]).optional(),
    }),
    async execute(args, ctx) {
      return delegate(underlying, "send_message", args, ctx);
    },
  };

  const sendInput: Tool = {
    name: "send_input",
    description:
      "Codex-shaped alias for `send_message` (same as followup_task).",
    parameters: z.object({
      agent_id: z.string().min(1),
      message: z.string().min(1),
      delivery: z.enum(["queue", "trigger"]).optional(),
    }),
    async execute(args, ctx) {
      return delegate(underlying, "send_message", args, ctx);
    },
  };

  const waitAgent: Tool = {
    name: "wait_agent",
    description:
      "Wait for activity. With agent_id (or job_ids/agent_ids): join that " +
      "child/job (same as wait_agents). Without targets: wait for parent " +
      "inbox activity (followup/steer/inject) — same as wait_inbox.",
    parameters: z.object({
      agent_id: z.string().min(1).optional(),
      agent_ids: z.array(z.string().min(1)).optional(),
      job_ids: z.array(z.string().min(1)).optional(),
      timeout_ms: z.number().int().positive().optional(),
    }),
    async execute(args, ctx) {
      const agentIds = [
        ...(args.agent_ids ?? []),
        ...(args.agent_id !== undefined ? [args.agent_id] : []),
      ];
      const jobIds = args.job_ids ?? [];
      if (agentIds.length === 0 && jobIds.length === 0) {
        const timeoutMs = Math.min(args.timeout_ms ?? 60_000, 600_000);
        try {
          const event = await waitInboxActivity({
            signal: ctx.abortSignal,
            timeoutMs,
          });
          const text =
            typeof event.content === "string"
              ? event.content
              : event.content
                  .filter(
                    (b): b is { type: "text"; text: string } =>
                      b.type === "text",
                  )
                  .map((b) => b.text)
                  .join("\n");
          return {
            content: JSON.stringify({
              wait: "inbox",
              target: event.target,
              text: text.length > 0 ? text : "(non-text content)",
            }),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const timedOut = message.includes("timed out");
          const aborted =
            message.includes("aborted") || ctx.abortSignal.aborted;
          return {
            content: JSON.stringify({
              wait: aborted ? "interrupted" : timedOut ? "timed_out" : "error",
              error: message,
            }),
            isError: !timedOut && !aborted,
          };
        }
      }
      return delegate(
        underlying,
        "wait_agents",
        {
          agent_ids: agentIds.length > 0 ? agentIds : undefined,
          job_ids: jobIds.length > 0 ? jobIds : undefined,
          timeout_ms: args.timeout_ms,
        },
        ctx,
      );
    },
  };

  const closeAgent: Tool = {
    name: "close_agent",
    description:
      "Codex-shaped alias for `interrupt_agent`: stop a child's current turn.",
    parameters: z.object({
      agent_id: z.string().min(1),
      reason: z.string().optional(),
    }),
    async execute(args, ctx) {
      return delegate(underlying, "interrupt_agent", args, ctx);
    },
  };

  return [spawnAgent, followupTask, sendInput, waitAgent, closeAgent];
}
