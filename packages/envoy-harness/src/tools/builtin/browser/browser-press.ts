/**
 * browser_press — send a keyboard key (Enter, Tab, Escape, …).
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../../types.js";
import { requireBrowserAccess } from "./gate.js";
import { browserSessionKey, getBrowserSessionManager } from "./session.js";

const params = z.object({
  key: z
    .string()
    .min(1)
    .describe("Playwright key name, e.g. Enter, Tab, Escape, Control+a"),
});

export const browserPressTool: Tool<typeof params> = {
  name: "browser_press",
  timeoutMs: 15_000,
  isConcurrencySafe: () => false,
  description: "Press a keyboard key in the shared browser page.",
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
      await page.press(args.key);
      return { content: `Pressed ${args.key}` };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
