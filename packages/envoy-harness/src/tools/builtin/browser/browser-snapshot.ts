/**
 * browser_snapshot — accessibility / ARIA tree with actionable refs.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../../types.js";
import { requireBrowserAccess } from "./gate.js";
import {
  browserSessionKey,
  collectSnapshotRefs,
  formatAccessibilityTree,
  getBrowserSessionManager,
} from "./session.js";

const params = z.object({});

export const browserSnapshotTool: Tool<typeof params> = {
  name: "browser_snapshot",
  timeoutMs: 30_000,
  isConcurrencySafe: () => true,
  description:
    "Return the page accessibility tree with [ref=eN] markers for interactive " +
    "nodes. Use those refs with browser_click / browser_type.",
  parameters: params,
  async execute(_args, ctx): Promise<ToolResult<string>> {
    const denied = requireBrowserAccess(ctx);
    if (denied) return denied;
    try {
      const mgr = getBrowserSessionManager();
      const page = mgr.getPage(browserSessionKey(ctx));
      if (page === undefined) {
        return {
          content: "No open browser page. Call browser_navigate first.",
          isError: true,
        };
      }
      const tree = await page.accessibilitySnapshot();
      const refs = collectSnapshotRefs(tree);
      page.setRefs(refs);
      const body =
        tree === null
          ? "(empty accessibility tree)"
          : formatAccessibilityTree(tree, refs);
      const header = `URL: ${page.url()}\nInteractive refs: ${refs.length}\n`;
      return { content: `${header}\n${body}` };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
