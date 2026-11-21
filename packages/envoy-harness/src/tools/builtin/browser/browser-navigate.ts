/**
 * browser_navigate — open/goto a URL in the shared Playwright session.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../../types.js";
import { requireBrowserAccess } from "./gate.js";
import {
  browserSessionKey,
  getBrowserSessionManager,
} from "./session.js";

const params = z.object({
  url: z.string().min(1).describe("Absolute URL to open"),
  wait_until: z
    .enum(["load", "domcontentloaded", "networkidle"])
    .optional()
    .describe("Playwright waitUntil (default load)"),
  headed: z
    .boolean()
    .optional()
    .describe(
      "true = headed Chromium; false = headless. Omit to keep this session's prior mode (default headless on first open).",
    ),
  timeout_ms: z.number().int().positive().optional(),
});

export const browserNavigateTool: Tool<typeof params> = {
  name: "browser_navigate",
  timeoutMs: 60_000,
  isConcurrencySafe: () => false,
  description:
    "Open or navigate the shared browser page to a URL (Playwright Chromium). " +
    "Headless by default; set headed=true when a display is available.",
  parameters: params,
  async execute(args, ctx): Promise<ToolResult<string>> {
    const denied = requireBrowserAccess(ctx);
    if (denied) return denied;
    try {
      const page = await getBrowserSessionManager().ensurePage(
        browserSessionKey(ctx),
        // Omit headed when unset so the session keeps its prior headed mode.
        args.headed !== undefined ? { headed: args.headed } : undefined,
      );
      await page.goto(args.url, {
        ...(args.wait_until !== undefined
          ? { waitUntil: args.wait_until }
          : {}),
        ...(args.timeout_ms !== undefined
          ? { timeoutMs: args.timeout_ms }
          : {}),
      });
      return { content: `Navigated to ${page.url()}` };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
