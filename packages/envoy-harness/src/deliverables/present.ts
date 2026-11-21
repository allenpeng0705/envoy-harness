/**
 * Wave 4 — `present` deliverable tool.
 */

import { z } from "zod";

import type { Session } from "../session.js";
import type { Tool, ToolResult } from "../tools/types.js";

export interface PresentedDeliverable {
  path: string;
  note?: string;
  presentedAt: string;
}

export function makePresentTool(options: {
  getSession: () => Session;
}): Tool {
  return {
    name: "present",
    description:
      "Mark a workspace path as a deliverable for the host UI to open/show.",
    parameters: z.object({
      path: z.string().min(1),
      note: z.string().optional(),
    }),
    async execute(args): Promise<ToolResult> {
      const session = options.getSession();
      const entry: PresentedDeliverable = {
        path: args.path,
        ...(args.note !== undefined ? { note: args.note } : {}),
        presentedAt: new Date().toISOString(),
      };
      const meta = session.metadata as {
        deliverables?: PresentedDeliverable[];
      };
      const list = [...(meta.deliverables ?? []), entry];
      meta.deliverables = list;
      return { content: JSON.stringify({ ok: true, deliverable: entry }) };
    },
  };
}
