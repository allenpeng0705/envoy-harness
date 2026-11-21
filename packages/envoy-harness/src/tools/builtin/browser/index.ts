/**
 * First-party browser tools (Playwright Chromium).
 */

export { browserNavigateTool } from "./browser-navigate.js";
export { browserSnapshotTool } from "./browser-snapshot.js";
export { browserClickTool } from "./browser-click.js";
export { browserTypeTool } from "./browser-type.js";
export { browserPressTool } from "./browser-press.js";
export { browserScreenshotTool } from "./browser-screenshot.js";
export { browserConsoleTool } from "./browser-console.js";
export { browserNetworkTool } from "./browser-network.js";
export { browserCloseTool } from "./browser-close.js";
export {
  requireBrowserAccess,
  browserAccessDeniedResult,
} from "./gate.js";
export {
  browserSessionKey,
  collectSnapshotRefs,
  formatAccessibilityTree,
  getBrowserSessionManager,
  headedModeForEnsure,
  setBrowserSessionManager,
  type BrowserConsoleEntry,
  type BrowserNetworkEntry,
  type BrowserPageHandle,
  type BrowserSessionManager,
  type BrowserSnapshotRef,
} from "./session.js";

import { browserClickTool } from "./browser-click.js";
import { browserCloseTool } from "./browser-close.js";
import { browserConsoleTool } from "./browser-console.js";
import { browserNavigateTool } from "./browser-navigate.js";
import { browserNetworkTool } from "./browser-network.js";
import { browserPressTool } from "./browser-press.js";
import { browserScreenshotTool } from "./browser-screenshot.js";
import { browserSnapshotTool } from "./browser-snapshot.js";
import { browserTypeTool } from "./browser-type.js";

/** All `browser_*` builtins, registration order. */
export const BROWSER_TOOLS = [
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserPressTool,
  browserScreenshotTool,
  browserConsoleTool,
  browserNetworkTool,
  browserCloseTool,
] as const;

export const BROWSER_TOOL_NAMES = BROWSER_TOOLS.map((t) => t.name) as ReadonlyArray<
  | "browser_navigate"
  | "browser_snapshot"
  | "browser_click"
  | "browser_type"
  | "browser_press"
  | "browser_screenshot"
  | "browser_console"
  | "browser_network"
  | "browser_close"
>;
