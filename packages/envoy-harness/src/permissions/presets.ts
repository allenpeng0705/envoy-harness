/**
 * R4.5b — named permission presets (dsh / EnvoyGo “one control”).
 *
 * One preset value expands to sandbox mode + AskForApproval +
 * AutoRunPolicy so UIs (TUI, EnvoyGo, Social) can set a single knob.
 */

import { z } from "zod";

import type { AskForApproval, PermissionMode } from "../types.js";
import type { AutoRunPolicy } from "./auto-run.js";

export const PermissionPresetNameSchema = z.enum([
  "safe",
  "ask-all",
  "approve-all",
]);
export type PermissionPresetName = z.infer<typeof PermissionPresetNameSchema>;

export interface PermissionPresetResolved {
  name: PermissionPresetName;
  permissionMode: PermissionMode;
  askForApproval: AskForApproval;
  autoRun: AutoRunPolicy;
  /** Short UI label. */
  label: string;
  /** One-line description for menus / `/preset` help. */
  description: string;
}

/**
 * Built-in presets. Order is menu display order.
 *
 * | Preset | Sandbox | Approval | Auto-run |
 * |---|---|---|---|
 * | safe | read-only | unless-trusted | always-confirm |
 * | ask-all | workspace-write | on-request | always-confirm |
 * | approve-all | danger-full-access | never | off |
 */
export const PERMISSION_PRESETS: ReadonlyArray<PermissionPresetResolved> = [
  {
    name: "safe",
    permissionMode: "read-only",
    askForApproval: "unless-trusted",
    autoRun: "always-confirm",
    label: "Safe",
    description: "Read-only sandbox; confirm every tool",
  },
  {
    name: "ask-all",
    permissionMode: "workspace-write",
    askForApproval: "on-request",
    autoRun: "always-confirm",
    label: "Ask all",
    description: "Workspace writes; confirm every tool",
  },
  {
    name: "approve-all",
    permissionMode: "danger-full-access",
    askForApproval: "never",
    autoRun: "off",
    label: "Approve all",
    description: "Full access; never ask (unattended)",
  },
];

const BY_NAME = new Map(
  PERMISSION_PRESETS.map((p) => [p.name, p] as const),
);

export function isPermissionPresetName(
  value: string,
): value is PermissionPresetName {
  return BY_NAME.has(value as PermissionPresetName);
}

export function resolvePermissionPreset(
  name: PermissionPresetName,
): PermissionPresetResolved {
  const preset = BY_NAME.get(name);
  if (preset === undefined) {
    throw new Error(`unknown permission preset: ${name}`);
  }
  return preset;
}

/**
 * Find the preset that exactly matches the live policy axes, or
 * `undefined` when the mix is custom.
 *
 * When `autoRun` is omitted, match on sandbox + approval only if that
 * pair uniquely identifies a preset.
 */
export function matchPermissionPreset(axes: {
  permissionMode: PermissionMode;
  askForApproval: AskForApproval;
  autoRun?: AutoRunPolicy;
}): PermissionPresetName | undefined {
  if (axes.autoRun !== undefined) {
    for (const p of PERMISSION_PRESETS) {
      if (
        p.permissionMode === axes.permissionMode &&
        p.askForApproval === axes.askForApproval &&
        p.autoRun === axes.autoRun
      ) {
        return p.name;
      }
    }
    return undefined;
  }
  const candidates = PERMISSION_PRESETS.filter(
    (p) =>
      p.permissionMode === axes.permissionMode &&
      p.askForApproval === axes.askForApproval,
  );
  return candidates.length === 1 ? candidates[0]!.name : undefined;
}

/** Expand a preset into a partial ConfigLayer-shaped object. */
export function permissionPresetToConfigFields(
  name: PermissionPresetName,
): {
  permissionPreset: PermissionPresetName;
  permissionMode: PermissionMode;
  askForApproval: AskForApproval;
  autoRun: AutoRunPolicy;
} {
  const p = resolvePermissionPreset(name);
  return {
    permissionPreset: p.name,
    permissionMode: p.permissionMode,
    askForApproval: p.askForApproval,
    autoRun: p.autoRun,
  };
}
