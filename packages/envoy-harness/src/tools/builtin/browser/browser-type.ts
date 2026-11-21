/**
 * browser_type — type into an input by selector or snapshot ref.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../../types.js";
import { requireBrowserAccess } from "./gate.js";
import { browserSessionKey, getBrowserSessionManager } from "./session.js";

const params = z.object({
  text: z.string().describe("Text to type"),
  selector: z.string().optional(),
  ref: z.string().optional(),
  clear: z
    .boolean()
    .optional()
    .describe("Replace existing value (fill) instead of append"),
});

export const browserTypeTool: Tool<typeof params> = {
  name: "browser_type",
  timeoutMs: 30_000,
  isConcurrencySafe: () => false,
  description:
    "Type into a field by selector or browser_snapshot ref. Use clear=true to replace.",
  parameters: params,
  async execute(args, ctx): Promise<ToolResult<string>> {
    const denied = requireBrowserAccess(ctx);
    if (denied) return denied;
    if (!args.selector && !args.ref) {
      return { content: "Provide selector or ref", isError: true };
    }
    try {
      const page = getBrowserSessionManager().getPage(browserSessionKey(ctx));
      if (page === undefined) {
        return {
          content: "No open browser page. Call browser_navigate first.",
          isError: true,
        };
      }
      await page.type(
        {
          ...(args.selector !== undefined ? { selector: args.selector } : {}),
          ...(args.ref !== undefined ? { ref: args.ref } : {}),
        },
        args.text,
        { clear: args.clear === true },
      );
      return {
        content: `Typed into ${args.ref ?? args.selector} (${args.text.length} chars)`,
      };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
