/**
 * Gate `device_*` tools behind the mobile preset / explicit allow.
 */

import { isMobileDeviceAccessAllowed } from "../../../permissions/mobile-roots.js";
import type { ToolContext, ToolResult } from "../../types.js";

export function mobileAccessDeniedResult(): ToolResult<string> {
  return {
    content:
      "device_* tools are gated. Enable with `--permission-preset mobile` " +
      '(or config `permissionPreset = "mobile"`), approve-all / danger-full-access, ' +
      "or set ENVOY_MOBILE_TOOLS=1.",
    isError: true,
  };
}

export function requireMobileAccess(
  ctx: ToolContext,
): ToolResult<string> | undefined {
  if (isMobileDeviceAccessAllowed(ctx.sandboxPolicy)) return undefined;
  return mobileAccessDeniedResult();
}
