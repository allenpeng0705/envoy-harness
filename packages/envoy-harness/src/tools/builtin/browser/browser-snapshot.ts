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
    "nodes when the a11y API is available. Use those refs with browser_click / " +
    "browser_type. On newer Playwright builds that only expose ariaSnapshot YAML, " +
    "refs may be empty — use CSS/role selectors instead.",
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
      const ariaFallback =
        tree !== null &&
        typeof tree === "object" &&
        typeof (tree as { ariaSnapshot?: unknown }).ariaSnapshot === "string";
      const headerParts = [
        `URL: ${page.url()}`,
        `Interactive refs: ${refs.length}`,
      ];
      if (ariaFallback && refs.length === 0) {
        headerParts.push(
          "Note: this Playwright build returned ariaSnapshot YAML only " +
            "(no structured refs). Use CSS/role selectors with browser_click / " +
            "browser_type, or install a Playwright that still exposes " +
            "accessibility.snapshot for ref=eN markers.",
        );
      }
      const header = `${headerParts.join("\n")}\n`;
      return { content: `${header}\n${body}` };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
