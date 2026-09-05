/**
 * @envoymesh/envoy-harness — permissions surface.
 */

export {
  AUTO_RUN_SAFE_TOOLS,
  isAutoRunSafeBashCommand,
  shouldAskUnderAutoRun,
  type AutoRunPolicy,
} from "./auto-run.js";

export { policyFromMode } from "./policy.js";

export {
  PERMISSION_PRESETS,
  PermissionPresetNameSchema,
  isPermissionPresetName,
  matchPermissionPreset,
  permissionPresetToConfigFields,
  resolvePermissionPreset,
  type PermissionPresetName,
  type PermissionPresetResolved,
} from "./presets.js";
