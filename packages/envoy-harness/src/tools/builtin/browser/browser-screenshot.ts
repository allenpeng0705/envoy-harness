/**
 * browser_screenshot — PNG → multimodal vision content.
 */

import { z } from "zod";

import type { MultimodalToolContent } from "../../multimodal.js";
import type { Tool, ToolResult } from "../../types.js";
import { requireBrowserAccess } from "./gate.js";
import { browserSessionKey, getBrowserSessionManager } from "./session.js";

const params = z.object({});

export const browserScreenshotTool: Tool<typeof params> = {
  name: "browser_screenshot",
  timeoutMs: 30_000,
  isConcurrencySafe: () => true,
  description:
    "Capture a PNG screenshot of the shared browser page and return it as " +
    "vision content for the model (multimodal tool result).",
  parameters: params,
  async execute(
    _args,
    ctx,
  ): Promise<ToolResult<MultimodalToolContent | string>> {
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
      const buf = await page.screenshot();
      const content: MultimodalToolContent = {
        text: `Screenshot of ${page.url()} (${buf.length} bytes PNG)`,
        images: [
          {
            mimeType: "image/png",
            data: buf.toString("base64"),
          },
        ],
      };
      return { content };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
