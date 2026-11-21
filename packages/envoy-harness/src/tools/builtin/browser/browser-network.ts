/**
 * browser_network — recent request/response summary.
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
});

export const browserNetworkTool: Tool<typeof params> = {
  name: "browser_network",
  timeoutMs: 10_000,
  isConcurrencySafe: () => true,
  description:
    "Summarize recent network responses (method, status, type, URL).",
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
      const entries = page.getNetwork(args.limit ?? 50);
      if (entries.length === 0) {
        return { content: "No network responses captured." };
      }
      const lines = entries.map((e) => {
        const status = e.status ?? "?";
        const type = e.resourceType ?? "?";
        return `${e.method} ${status} ${type} ${e.url}`;
      });
      return { content: lines.join("\n") };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
