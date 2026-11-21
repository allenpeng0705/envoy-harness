/**
 * First-party mobile device tools (iOS Simulator + Android Emulator).
 */

export { deviceListTool } from "./device-list.js";
export { deviceBootTool } from "./device-boot.js";
export { deviceInstallTool } from "./device-install.js";
export { deviceLaunchTool } from "./device-launch.js";
export { deviceScreenshotTool } from "./device-screenshot.js";
export { deviceUiTreeTool } from "./device-ui-tree.js";
export { deviceTestTool } from "./device-test.js";
export {
  defaultHostCommandRunner,
  getHostCommandRunner,
  runHostCommand,
  setHostCommandRunner,
  type HostCommandResult,
  type HostCommandRunner,
} from "./exec.js";
export { requireMobileAccess, mobileAccessDeniedResult } from "./gate.js";

import { deviceBootTool } from "./device-boot.js";
import { deviceInstallTool } from "./device-install.js";
import { deviceLaunchTool } from "./device-launch.js";
import { deviceListTool } from "./device-list.js";
import { deviceScreenshotTool } from "./device-screenshot.js";
import { deviceTestTool } from "./device-test.js";
import { deviceUiTreeTool } from "./device-ui-tree.js";

/** All `device_*` builtins, registration order. */
export const MOBILE_DEVICE_TOOLS = [
  deviceListTool,
  deviceBootTool,
  deviceInstallTool,
  deviceLaunchTool,
  deviceScreenshotTool,
  deviceUiTreeTool,
  deviceTestTool,
] as const;

export const MOBILE_DEVICE_TOOL_NAMES = MOBILE_DEVICE_TOOLS.map(
  (t) => t.name,
) as ReadonlyArray<
  | "device_list"
  | "device_boot"
  | "device_install"
  | "device_launch"
  | "device_screenshot"
  | "device_ui_tree"
  | "device_test"
>;
