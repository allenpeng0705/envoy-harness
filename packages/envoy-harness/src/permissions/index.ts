/**
 * @envoymesh/envoy-harness — permissions surface.
 */

export {
  AUTO_RUN_SAFE_TOOLS,
  AUTO_RUN_WORKSPACE_MUTATION_TOOLS,
  isAutoRunSafeBashCommand,
  isPathInsideWorkspace,
  shouldAskUnderAutoRun,
  type AutoRunPolicy,
  type ShouldAskUnderAutoRunOptions,
} from "./auto-run.js";

export { policyFromMode } from "./policy.js";

export {
  PERMISSION_PRESETS,
  PermissionPresetNameSchema,
  isPermissionPresetName,
  matchPermissionPreset,
  permissionPresetToConfigFields,
  resolvePermissionPreset,
  resolvePresetWritableRoots,
  type PermissionPresetName,
  type PermissionPresetResolved,
} from "./presets.js";

export {
  ENVOY_MOBILE_TOOLS_ENV,
  isMobileDeviceAccessAllowed,
  isMobileWritableRoot,
  mobileWritableRoots,
} from "./mobile-roots.js";

export {
  ENVOY_WEB_TOOLS_ENV,
  isWebBrowserAccessAllowed,
  isWebdevWritableRoot,
  webdevWritableRoots,
} from "./webdev-roots.js";
