/**
 * Phase D / Item 16 — model-facing feedback tool.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { FeedbackStore } from "./record.js";

/** Build `feedback_record` bound to a store. */
export function makeFeedbackTools(store: FeedbackStore): Tool[] {
  const feedbackRecord: Tool = {
    name: "feedback_record",
    description:
      "Record an append-only feedback event for the current session. " +
      "Notes are stored but never injected into model prompts.",
    parameters: z.object({
      polarity: z.enum(["up", "down", "neutral"]),
      messageIndex: z.number().int().nonnegative().optional(),
      note: z.string().optional(),
      score: z.number().min(-1).max(1).optional(),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const event = await store.record({
          sessionId: ctx.session.id,
          polarity: args.polarity,
          ...(args.messageIndex !== undefined
            ? { messageIndex: args.messageIndex }
            : {}),
          ...(args.note !== undefined ? { note: args.note } : {}),
          ...(args.score !== undefined ? { score: args.score } : {}),
        });
        return {
          content: JSON.stringify({
            id: event.id,
            ts: event.ts,
            polarity: event.polarity,
            sessionId: event.sessionId,
          }),
        };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
  return [feedbackRecord];
}

/** Register feedback tools on a registry. */
export function registerFeedbackTools(
  tools: ToolRegistry,
  store: FeedbackStore,
): void {
  for (const t of makeFeedbackTools(store)) tools.register(t);
}
