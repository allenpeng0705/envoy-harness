/**
 * Model-facing `todo_write` — Cursor TodoWrite / Codex checklist for ACP clients.
 *
 * Replaces the session's plan items and notifies listeners so ACP can push
 * `plan_update`. Prefer one `in_progress` entry at a time.
 */

import { z } from "zod";

import type { Tool } from "../tools/types.js";
import {
  type PlanItem,
  type PlanItemPriority,
  type PlanItemStatus,
} from "./items.js";

const statusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
const prioritySchema = z.enum(["high", "medium", "low"]);

const entrySchema = z.object({
  id: z.string().min(1).optional(),
  content: z.string().min(1),
  status: statusSchema,
  priority: prioritySchema.optional(),
});

export function makeTodoWriteTool(opts: {
  /** Called after items are persisted so ACP can emit `plan_update`. */
  onChange?: (sessionId: string, items: readonly PlanItem[]) => void;
}): Tool {
  const { onChange } = opts;
  return {
    name: "todo_write",
    description:
      "Update the session's execution checklist (todos). Call this when you " +
      "start a multi-step task, when you finish a step, and when you change " +
      "course. Pass the full list each time. Keep exactly one item " +
      "in_progress while actively working. After an approved plan, seed " +
      "todos from the plan phases.",
    parameters: z.object({
      todos: z
        .array(entrySchema)
        .describe("Complete checklist — replaces the previous list."),
    }),
    async execute(args, ctx) {
      const items: PlanItem[] = args.todos.map(
        (
          todo: {
            id?: string;
            content: string;
            status: PlanItemStatus;
            priority?: PlanItemPriority;
          },
          index: number,
        ) => ({
          id: todo.id?.trim() || `todo-${index + 1}`,
          content: todo.content.trim(),
          status: todo.status,
          ...(todo.priority !== undefined ? { priority: todo.priority } : {}),
        }),
      );
      ctx.session.setPlanItems(items);
      onChange?.(ctx.session.id, items);
      const summary = items
        .map((item) => `- [${item.status}] ${item.content}`)
        .join("\n");
      return {
        content:
          items.length === 0
            ? "Checklist cleared."
            : `Checklist updated (${items.length}):\n${summary}`,
      };
    },
  };
}
