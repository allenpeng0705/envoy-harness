/**
 * Apply a ConfigLayer to session permission / approval / sandbox.
 */

import type { ConfigLayer } from "./schema.js";
import type { AskForApproval, PermissionMode, SandboxPolicy } from "../types.js";
import type { AutoRunPolicy } from "../permissions/auto-run.js";
import { policyFromMode } from "../permissions/policy.js";
import { resolvePermissionPreset } from "../permissions/presets.js";

export interface ResolvedAgentRuntimeConfig {
  permissionMode: PermissionMode;
  askForApproval: AskForApproval;
  sandboxPolicy: SandboxPolicy;
  /** R4.5b — resolved auto-run policy (from preset or layer). */
  autoRun?: AutoRunPolicy;
  /** R4.5b — preset name when the layer requested one. */
  permissionPreset?: ConfigLayer["permissionPreset"];
}

/**
 * Resolve permission + approval + sandbox from a config layer.
 * Defaults match ACP/Envoy chat (writable workspace) when unset.
 *
 * When `permissionPreset` is set, it supplies sandbox + approval +
 * autoRun as defaults; explicit `permissionMode` / `askForApproval` /
 * `autoRun` on the same layer override individual axes.
 */
export function resolveAgentRuntimeConfig(
  cwd: string,
  layer: ConfigLayer = {},
  defaults: {
    permissionMode?: PermissionMode;
    askForApproval?: AskForApproval;
    autoRun?: AutoRunPolicy;
  } = {},
): ResolvedAgentRuntimeConfig {
  const fromPreset =
    layer.permissionPreset !== undefined
      ? resolvePermissionPreset(layer.permissionPreset)
      : undefined;

  const permissionMode =
    layer.permissionMode ??
    fromPreset?.permissionMode ??
    defaults.permissionMode ??
    "workspace-write";
  const askForApproval =
    layer.askForApproval ??
    fromPreset?.askForApproval ??
    defaults.askForApproval ??
    "on-request";
  const autoRun =
    layer.autoRun ?? fromPreset?.autoRun ?? defaults.autoRun;

  const base = policyFromMode(permissionMode, cwd);
  const sandboxPolicy: SandboxPolicy = {
    ...base,
    approval: askForApproval,
    ...(layer.sandboxBackend !== undefined
      ? { backend: layer.sandboxBackend }
      : {}),
    ...(layer.networkAccess !== undefined
      ? { networkAccess: layer.networkAccess }
      : {}),
    ...(layer.slashTmpWritable !== undefined
      ? { slashTmpWritable: layer.slashTmpWritable }
      : {}),
    writableRoots: [
      ...base.writableRoots,
      ...(layer.writableRoots ?? []),
    ],
  };
  return {
    permissionMode,
    askForApproval,
    sandboxPolicy,
    ...(autoRun !== undefined ? { autoRun } : {}),
    ...(layer.permissionPreset !== undefined
      ? { permissionPreset: layer.permissionPreset }
      : {}),
  };
}

/** Options passed through to `buildAgentSystemPrompt` from a layer. */
export function systemPromptOptionsFromConfig(layer: ConfigLayer): {
  persona?: string;
  developerInstructions?: string;
  includeHarnessIdentity?: boolean;
  permissionMode?: PermissionMode;
  askForApproval?: AskForApproval;
  projectDocFallbackFilenames?: ReadonlyArray<string>;
} {
  return {
    ...(layer.persona !== undefined ? { persona: layer.persona } : {}),
    ...(layer.developerInstructions !== undefined
      ? { developerInstructions: layer.developerInstructions }
      : {}),
    ...(layer.includeHarnessIdentity !== undefined
      ? { includeHarnessIdentity: layer.includeHarnessIdentity }
      : {}),
    ...(layer.permissionMode !== undefined
      ? { permissionMode: layer.permissionMode }
      : {}),
    ...(layer.askForApproval !== undefined
      ? { askForApproval: layer.askForApproval }
      : {}),
    ...(layer.projectDocFallbackFilenames !== undefined
      ? { projectDocFallbackFilenames: layer.projectDocFallbackFilenames }
      : {}),
  };
}
