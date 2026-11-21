/**
 * browser_click — click by CSS/role selector or snapshot ref.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../../types.js";
import { requireBrowserAccess } from "./gate.js";
import { browserSessionKey, getBrowserSessionManager } from "./session.js";

const params = z.object({
  selector: z
    .string()
    .optional()
    .describe("CSS or Playwright locator string"),
  ref: z
    .string()
    .optional()
    .describe("ref from browser_snapshot (e.g. e3)"),
});

export const browserClickTool: Tool<typeof params> = {
  name: "browser_click",
  timeoutMs: 30_000,
  isConcurrencySafe: () => false,
  description:
    "Click an element by selector or by ref from the latest browser_snapshot.",
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
      await page.click({
        ...(args.selector !== undefined ? { selector: args.selector } : {}),
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
      });
      return {
        content: `Clicked ${args.ref ?? args.selector} (url=${page.url()})`,
      };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
