import { z } from "zod";

import type { Tool, ToolResult } from "../tools/types.js";
import type { GoalStore } from "./store.js";

export function makeGoalTools(store: GoalStore): Tool[] {
  return [
    {
      name: "create_goal",
      description: "Create a long-running goal for this session.",
      parameters: z.object({
        title: z.string().min(1),
        detail: z.string().optional(),
      }),
      async execute(args): Promise<ToolResult> {
        const goal = store.create(args);
        return { content: JSON.stringify({ ok: true, goal }) };
      },
    },
    {
      name: "get_goal",
      description: "Fetch a goal by id.",
      parameters: z.object({ id: z.string().min(1) }),
      isConcurrencySafe: () => true,
      async execute(args): Promise<ToolResult> {
        const goal = store.get(args.id);
        if (goal === undefined) {
          return { content: `unknown goal '${args.id}'`, isError: true };
        }
        return { content: JSON.stringify({ ok: true, goal }) };
      },
    },
    {
      name: "update_goal",
      description: "Update goal title/detail/status (active|paused|completed|blocked).",
      parameters: z.object({
        id: z.string().min(1),
        title: z.string().optional(),
        detail: z.string().optional(),
        status: z
          .enum(["active", "paused", "completed", "blocked"])
          .optional(),
      }),
      async execute(args): Promise<ToolResult> {
        try {
          const { id, ...patch } = args;
          const goal = store.update(id, patch);
          return { content: JSON.stringify({ ok: true, goal }) };
        } catch (err) {
          return {
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    },
  ];
}
