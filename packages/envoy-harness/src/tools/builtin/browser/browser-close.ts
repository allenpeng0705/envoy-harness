/**
 * browser_close — close the shared page/context for this agent session.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../../types.js";
import { requireBrowserAccess } from "./gate.js";
import { browserSessionKey, getBrowserSessionManager } from "./session.js";

const params = z.object({});

export const browserCloseTool: Tool<typeof params> = {
  name: "browser_close",
  timeoutMs: 15_000,
  isConcurrencySafe: () => false,
  description: "Close the shared Playwright page/context for this session.",
  parameters: params,
  async execute(_args, ctx): Promise<ToolResult<string>> {
    const denied = requireBrowserAccess(ctx);
    if (denied) return denied;
    try {
      const key = browserSessionKey(ctx);
      const mgr = getBrowserSessionManager();
      if (mgr.getPage(key) === undefined) {
        return { content: "No open browser page." };
      }
      await mgr.close(key);
      return { content: "Browser page closed." };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
