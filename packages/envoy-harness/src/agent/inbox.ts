/**
 * DeepSeek-lite parent inbox: next-turn vs next-step queues.
 *
 * **followup** → `next-turn` + wake
 * **steer** → `next-step` + wake
 * **inject** → `next-step`, no wake
 *
 * Claim rules (DeepSeek-shaped):
 * - turn-start: all `next-step` + one `next-turn`
 * - step: all `next-step` only
 */

import { z } from "zod";

import type {
  PendingInboxSnapshot,
  PendingInboxStoredEntry,
} from "../session.js";
import type { ContentBlock, Tool, ToolResult } from "../tools/types.js";

/** Where a host message is parked until the agent admits it. */
export type InboxTarget = "next-turn" | "next-step";

/** One inbox entry — text or content blocks. */
export type InboxContent = string | ReadonlyArray<ContentBlock>;

export interface InboxEntry {
  readonly target: InboxTarget;
  readonly content: InboxContent;
  readonly enqueuedAt: string;
}

export interface InboxActivityEvent {
  readonly target: InboxTarget;
  readonly content: InboxContent;
}

type ActivityListener = (event: InboxActivityEvent) => void;

/** Normalize inbox content to transcript content blocks. */
export function inboxContentToBlocks(
  content: InboxContent,
): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return [...content];
}

function cloneInboxContent(content: InboxContent): InboxContent {
  if (typeof content === "string") return content;
  return JSON.parse(JSON.stringify(content)) as ContentBlock[];
}

/**
 * In-memory parent inbox. Agent mirrors queues onto
 * `session.metadata.pendingInbox` for `--resume` (Gap 4b).
 */
export class AgentInbox {
  readonly #nextTurn: InboxEntry[] = [];
  readonly #nextStep: InboxEntry[] = [];
  readonly #activityListeners = new Set<ActivityListener>();

  get nextTurnLength(): number {
    return this.#nextTurn.length;
  }

  get nextStepLength(): number {
    return this.#nextStep.length;
  }

  get isEmpty(): boolean {
    return this.#nextTurn.length === 0 && this.#nextStep.length === 0;
  }

  /** Append one message to the given target. */
  enqueue(target: InboxTarget, content: InboxContent): InboxEntry {
    const entry: InboxEntry = {
      target,
      content,
      enqueuedAt: new Date().toISOString(),
    };
    if (target === "next-turn") this.#nextTurn.push(entry);
    else this.#nextStep.push(entry);
    for (const listener of this.#activityListeners) {
      try {
        listener({ target, content });
      } catch {
        /* ignore listener errors */
      }
    }
    return entry;
  }

  /**
   * First admission of a turn: drain every next-step message, then
   * take at most one next-turn message.
   */
  claimTurnStart(): InboxEntry[] {
    const steps = this.#nextStep.splice(0, this.#nextStep.length);
    const turn =
      this.#nextTurn.length > 0 ? [this.#nextTurn.shift()!] : [];
    return [...steps, ...turn];
  }

  /** Later steps in a turn: drain next-step only. */
  claimStep(): InboxEntry[] {
    return this.#nextStep.splice(0, this.#nextStep.length);
  }

  /** Subscribe to enqueue activity (Gap 2 wait). Returns unsubscribe. */
  onActivity(listener: ActivityListener): () => void {
    this.#activityListeners.add(listener);
    return () => {
      this.#activityListeners.delete(listener);
    };
  }

  /** Drop all pending messages (dispose / cancel). */
  clear(): void {
    this.#nextTurn.length = 0;
    this.#nextStep.length = 0;
  }

  /** Serializable snapshot for session metadata (order preserved per queue). */
  snapshot(): PendingInboxSnapshot {
    const mapEntry = (e: InboxEntry): PendingInboxStoredEntry => ({
      target: e.target,
      content: cloneInboxContent(e.content),
      enqueuedAt: e.enqueuedAt,
    });
    return {
      nextTurn: this.#nextTurn.map(mapEntry),
      nextStep: this.#nextStep.map(mapEntry),
    };
  }

  /**
   * Replace queues from a durable snapshot. Does **not** fire activity
   * listeners (resume must not wake waiters).
   */
  restore(snapshot: PendingInboxSnapshot): void {
    this.clear();
    for (const e of snapshot.nextTurn) {
      this.#nextTurn.push({
        target: "next-turn",
        content: cloneInboxContent(e.content),
        enqueuedAt: e.enqueuedAt,
      });
    }
    for (const e of snapshot.nextStep) {
      this.#nextStep.push({
        target: "next-step",
        content: cloneInboxContent(e.content),
        enqueuedAt: e.enqueuedAt,
      });
    }
  }
}

/**
 * Model-facing wait on parent inbox activity (Gap 2).
 * Distinct from settlement `wait_agents` (child job join).
 */
export function makeWaitInboxActivityTool(options: {
  wait: (opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<{ target: InboxTarget; content: InboxContent }>;
}): Tool {
  return {
    name: "wait_inbox",
    description:
      "Block until the host enqueues a followup, steer, or inject on this " +
      "agent's inbox (parent input activity). Distinct from wait_agents, " +
      "which joins background child jobs. Use when you need human or host " +
      "steering before continuing.",
    parameters: z.object({
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max wait in ms (default 60000, capped at 600000)"),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      const timeoutMs = Math.min(args.timeout_ms ?? 60_000, 600_000);
      try {
        const event = await options.wait({
          signal: ctx.abortSignal,
          timeoutMs,
        });
        const text =
          typeof event.content === "string"
            ? event.content
            : event.content
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("\n");
        return {
          content: JSON.stringify({
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
    },
  };
}
