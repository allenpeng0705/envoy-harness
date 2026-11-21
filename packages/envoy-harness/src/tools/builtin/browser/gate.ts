/**
 * Gate `browser_*` tools behind the webdev preset / explicit allow.
 */

import { isWebBrowserAccessAllowed } from "../../../permissions/webdev-roots.js";
import type { ToolContext, ToolResult } from "../../types.js";

export function browserAccessDeniedResult(): ToolResult<string> {
  return {
    content:
      "browser_* tools are gated. Enable with `--permission-preset webdev` " +
      '(or config `permissionPreset = "webdev"`), approve-all / danger-full-access, ' +
      "or set ENVOY_WEB_TOOLS=1.",
    isError: true,
  };
}

export function requireBrowserAccess(
  ctx: ToolContext,
): ToolResult<string> | undefined {
  if (isWebBrowserAccessAllowed(ctx.sandboxPolicy)) return undefined;
  return browserAccessDeniedResult();
}
