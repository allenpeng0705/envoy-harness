/**
 * browser_console — recent console messages / errors.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../../types.js";
import { requireBrowserAccess } from "./gate.js";
import { browserSessionKey, getBrowserSessionManager } from "./session.js";

const params = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max entries (default 50)"),
  errors_only: z
    .boolean()
    .optional()
    .describe("Only error / warning messages"),
});

export const browserConsoleTool: Tool<typeof params> = {
  name: "browser_console",
  timeoutMs: 10_000,
  isConcurrencySafe: () => true,
  description:
    "Return recent browser console messages captured since the page opened.",
  parameters: params,
  async execute(args, ctx): Promise<ToolResult<string>> {
    const denied = requireBrowserAccess(ctx);
    if (denied) return denied;
    try {
      const page = getBrowserSessionManager().getPage(browserSessionKey(ctx));
      if (page === undefined) {
        return {
          content: "No open browser page. Call browser_navigate first.",
          isError: true,
        };
      }
      let entries = page.getConsole(args.limit ?? 50);
      if (args.errors_only) {
        entries = entries.filter(
          (e) => e.type === "error" || e.type === "warning",
        );
      }
      if (entries.length === 0) {
        return { content: "No console messages captured." };
      }
      const lines = entries.map(
        (e) => `[${e.type}] ${e.text}`,
      );
      return { content: lines.join("\n") };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
