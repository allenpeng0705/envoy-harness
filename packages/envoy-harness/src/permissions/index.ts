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
  type PermissionPresetName,
  type PermissionPresetResolved,
} from "./presets.js";
