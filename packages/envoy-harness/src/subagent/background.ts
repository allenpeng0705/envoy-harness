/**
 * Background (asynchronous) sub-agents.
 *
 * **The problem this solves.** `task` used to be the only way to spawn a
 * child, and it always *awaited* the child's result: the parent's turn
 * was blocked for the child's whole lifetime, including when the child
 * was a long research run the parent did not need immediately. The
 * continuable runtime ({@link ContinuableSubagentRegistry}) already
 * existed and could start a child without blocking, but nothing called
 * it, so the capability was unreachable from the model.
 *
 * **How it fits together.**
 *
 * - `spawnBackgroundSubagent` starts a continuable child and registers it
 *   in the {@link JobRegistry} as a `subagent` job. The registry — not
 *   this module — owns the id, the status, the waiters and the
 *   per-owner cap, so the existing `job_status` / `job_output` /
 *   `job_wait` / `job_kill` / `job_list` tools work on sub-agent jobs
 *   with no change (the registry's own type comment already reserved
 *   `subagent-N` ids).
 * - `makeSubagentControlTools` adds the three control tools over the live
 *   handle registry: `list_agents`, `send_message`, `interrupt_agent`.
 *
 * **Two background modes.**
 *
 * - `one-shot` — the child runs its objective and settles. The job
 *   completes with the final text. This is the default.
 * - `continuable` — the child stays alive after its first turn, so the
 *   parent can steer it with `send_message` (each message is another
 *   turn). The job stays `running` until the child settles or is killed.
 *
 * **`readOutput` is turn-granular, not token-granular.** Output is
 * appended once per completed turn (via the continuable runtime's
 * `onTurn` hook), so `job_output` shows progress between turns but not
 * mid-turn. Streaming mid-turn output would require plumbing the child's
 * tracer; that is a deliberate non-goal here.
 */

import { z } from "zod";

import type { JobOutcome, JobRegistry, JobStatus } from "../jobs/index.js";
import type { Tool, ToolResult } from "../tools/types.js";
import type {
  ContinuableSubmitter,
  ContinuableSubagentHandle,
} from "./continuable.js";
import type {
  MeshSubmitter,
  SubagentInput,
  SubagentResult,
} from "./types.js";

/** How long a background child lives. */
export type SubagentBackgroundMode = "one-shot" | "continuable";

export interface SpawnBackgroundOptions {
  /** A submitter that can run continuable children. */
  submitter: ContinuableSubmitter;
  /** The registry that owns the job identity and lifecycle. */
  jobs: JobRegistry;
  input: SubagentInput;
  /** Default `"one-shot"`. */
  mode?: SubagentBackgroundMode;
  /** Job owner (the parent session id). */
  owner?: string;
  /** Job label. Defaults to the objective. */
  label?: string;
  outputLimitBytes?: number;
  /** Parent abort — propagates to the child. */
  parentSignal?: AbortSignal;
  /**
   * Called once per completed turn with that turn's result. Used by the
   * parent to fold the child's cost into its own tracker. It is **not**
   * called again at settle — the settling result is the last turn's
   * result, so calling back there would double-count.
   */
  onResult?: (result: SubagentResult) => void;
}

export interface SpawnBackgroundResult {
  jobId: string;
  /** The child's durable id (also its session id). */
  agentId: string;
  status: JobStatus;
}

/**
 * Start a child in the background and register it as a `subagent` job.
 *
 * The child is created **inside** `jobs.start`'s `run()` hook, so the
 * registry's per-owner cap is enforced *before* a child exists. Creating
 * it first and registering second would leak a running child whenever
 * the cap rejected the job.
 */
export function spawnBackgroundSubagent(
  options: SpawnBackgroundOptions,
): SpawnBackgroundResult {
  const mode: SubagentBackgroundMode = options.mode ?? "one-shot";
  let handle: ContinuableSubagentHandle | undefined;
  let cancelRequested = false;
  /**
   * How much of the child's output has been handed out. `job_output`
   * promises "new output since the last read", and bash jobs honour that
   * with a consuming cursor, so a sub-agent job must too — otherwise a
   * poller would re-print the whole transcript on every read.
   */
  let consumed = 0;

  const jobId = options.jobs.start({
    kind: "subagent",
    label: options.label ?? options.input.objective,
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    ...(options.outputLimitBytes !== undefined
      ? { outputLimitBytes: options.outputLimitBytes }
      : {}),
    run: () => {
      handle = options.submitter.submitContinuable(options.input, {
        autoSettleAfterIdle: mode === "one-shot",
        onTurn: (result) => {
          try {
            options.onResult?.(result);
          } catch {
            // A host callback must not break the child.
          }
        },
        ...(options.parentSignal !== undefined
          ? { parentSignal: options.parentSignal }
          : {}),
      });
      const child = handle;
      return {
        cancel: (reason) => {
          cancelRequested = true;
          child.interrupt(reason ?? "cancelled by job_kill");
        },
        // The runtime owns the buffer: completed turns plus the in-flight
        // turn's streamed text, so a read shows progress within a turn.
        readOutput: () => {
          const full = child.output();
          // The runtime keeps a bounded tail, so the buffer can shrink.
          // Re-emit rather than silently lose the reader's place.
          if (full.length < consumed) consumed = 0;
          const delta = full.slice(consumed);
          consumed = full.length;
          return delta;
        },
        done: child.waitSettle().then(
          (result): JobOutcome => ({
            status: cancelRequested
              ? "killed"
              : result.status === "failed"
                ? "failed"
                : "completed",
            detail: `subagent ${child.id} settled ${result.status}`,
            output: child.output(),
          }),
        ),
      };
    },
  });

  if (handle === undefined) {
    // `run()` is invoked synchronously by `start`, so this is unreachable
    // — but returning an id for a child that does not exist would be a
    // silent lie, so fail loudly instead.
    throw new Error("spawnBackgroundSubagent: submitter did not start a child");
  }

  return {
    jobId,
    agentId: handle.id,
    status: options.jobs.get(jobId, options.owner).status,
  };
}

// ---------------------------------------------------------------------------
// Control tools
// ---------------------------------------------------------------------------

/** A submitter that can also be listed and steered. */
export type SteerableSubmitter = MeshSubmitter & Partial<ContinuableSubmitter>;

/** True when the submitter can serve background/steerable children. */
export function supportsContinuable(
  submitter: MeshSubmitter,
): submitter is SteerableSubmitter & ContinuableSubmitter {
  return (
    typeof (submitter as Partial<ContinuableSubmitter>).submitContinuable ===
      "function" &&
    typeof (submitter as Partial<ContinuableSubmitter>).getHandle === "function"
  );
}

function errResult(message: string): ToolResult {
  return { content: message, isError: true };
}

const ListAgentsParams = z.object({});
const SendMessageParams = z.object({
  agent_id: z.string().describe("Child id from list_agents or the task result"),
  message: z.string().min(1).describe("The follow-up instruction"),
});
const InterruptAgentParams = z.object({
  agent_id: z.string().describe("Child id from list_agents or the task result"),
  reason: z.string().optional().describe("Why it was interrupted"),
});

/**
 * The three control tools: `list_agents`, `send_message`,
 * `interrupt_agent`.
 *
 * A child cannot use these on its parent: the child is a separate `Agent`
 * with its own tool registry, and this factory is registered by the
 * parent's `Agent`. Parent→child steering is the scope here.
 */
export function makeSubagentControlTools(
  submitter: SteerableSubmitter,
): Tool[] {
  const listAgents: Tool<typeof ListAgentsParams> = {
    name: "list_agents",
    description:
      "List the child agents this session has spawned, with their durable " +
      "id, status, objective and cost. Use it to find the id for " +
      "send_message / interrupt_agent, or to check whether a background " +
      "child is still running.",
    parameters: ListAgentsParams,
    async execute(): Promise<ToolResult> {
      const records =
        typeof submitter.listSubagents === "function"
          ? submitter.listSubagents()
          : [];
      return {
        content: JSON.stringify({
          agents: records.map((r) => ({
            id: r.sessionId,
            capability_tag: r.capabilityTag,
            objective: r.objective,
            status: r.status,
            started_at: r.startedAt,
            ...(r.completedAt !== undefined
              ? { completed_at: r.completedAt }
              : {}),
            ...(r.costUsd !== undefined ? { cost_usd: r.costUsd } : {}),
            ...(r.durationMs !== undefined ? { duration_ms: r.durationMs } : {}),
          })),
        }),
      };
    },
  };

  const sendMessage: Tool<typeof SendMessageParams> = {
    name: "send_message",
    description:
      "Send a follow-up message to a continuable child agent. The message " +
      "runs as the child's next turn; the child keeps its own session, " +
      "context and tools. Only works on children started with " +
      "`run_in_background` in `continuable` mode (a one-shot child has " +
      "already settled).",
    parameters: SendMessageParams,
    async execute(args): Promise<ToolResult> {
      const handle = submitter.getHandle?.(args.agent_id);
      if (handle === undefined) {
        return errResult(
          `no continuable child '${args.agent_id}' in this session (it may have settled, or been started without run_in_background)`,
        );
      }
      try {
        await handle.send(args.message);
      } catch (err) {
        return errResult(err instanceof Error ? err.message : String(err));
      }
      return {
        content: JSON.stringify({
          queued: true,
          agent_id: args.agent_id,
          status: handle.status().status,
        }),
      };
    },
  };

  const interruptAgent: Tool<typeof InterruptAgentParams> = {
    name: "interrupt_agent",
    description:
      "Stop a child agent's current turn. Use this when the child is going " +
      "the wrong way and you want to redirect it with send_message. " +
      "To cancel the child's background job entirely, use job_kill on its " +
      "job id instead.",
    parameters: InterruptAgentParams,
    async execute(args): Promise<ToolResult> {
      const handle = submitter.getHandle?.(args.agent_id);
      if (handle === undefined) {
        return errResult(
          `no continuable child '${args.agent_id}' in this session (it may have settled)`,
        );
      }
      handle.interrupt(args.reason);
      return {
        content: JSON.stringify({
          interrupted: true,
          agent_id: args.agent_id,
          status: handle.status().status,
        }),
      };
    },
  };

  return [listAgents, sendMessage, interruptAgent];
}
