/**
 * Wave 3 — schedule_* model tools.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../tools/types.js";
import type { ScheduleStore } from "./store.js";

export function makeScheduleTools(store: ScheduleStore): Tool[] {
  const create: Tool = {
    name: "schedule_create",
    description:
      "Create a scheduled task that injects a prompt into the agent inbox when due.",
    parameters: z.object({
      prompt: z.string().min(1),
      runAt: z.string().optional().describe("ISO time for first/once run."),
      everyMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Repeat interval in ms."),
    }),
    async execute(args): Promise<ToolResult> {
      const task = store.create(args);
      return { content: JSON.stringify({ ok: true, task }) };
    },
  };
  const edit: Tool = {
    name: "schedule_edit",
    description: "Edit a scheduled task.",
    parameters: z.object({
      id: z.string().min(1),
      prompt: z.string().optional(),
      enabled: z.boolean().optional(),
      everyMs: z.number().int().positive().optional(),
      runAt: z.string().optional(),
    }),
    async execute(args): Promise<ToolResult> {
      try {
        const { id, ...patch } = args;
        const task = store.edit(id, patch);
        return { content: JSON.stringify({ ok: true, task }) };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
  const list: Tool = {
    name: "schedule_list",
    description: "List scheduled tasks.",
    parameters: z.object({}),
    isConcurrencySafe: () => true,
    async execute(): Promise<ToolResult> {
      return { content: JSON.stringify({ ok: true, tasks: store.list() }) };
    },
  };
  const view: Tool = {
    name: "schedule_view",
    description: "View one scheduled task.",
    parameters: z.object({ id: z.string().min(1) }),
    isConcurrencySafe: () => true,
    async execute(args): Promise<ToolResult> {
      const task = store.view(args.id);
      if (task === undefined) {
        return { content: `unknown schedule '${args.id}'`, isError: true };
      }
      return { content: JSON.stringify({ ok: true, task }) };
    },
  };
  return [create, edit, list, view];
}
