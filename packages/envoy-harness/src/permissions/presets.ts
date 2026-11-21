/**
 * R4.5b — named permission presets (dsh / EnvoyGo “one control”).
 *
 * One preset value expands to sandbox mode + AskForApproval +
 * AutoRunPolicy so UIs (TUI, EnvoyGo, Social) can set a single knob.
 */

import { z } from "zod";

import type { AskForApproval, PermissionMode } from "../types.js";
import type { AutoRunPolicy } from "./auto-run.js";
import { mobileWritableRoots } from "./mobile-roots.js";
import { webdevWritableRoots } from "./webdev-roots.js";

export const PermissionPresetNameSchema = z.enum([
  "safe",
  "ask-all",
  "approve-all",
  "mobile",
  "webdev",
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
  /**
   * Optional sandbox extras. Applied by
   * `resolveAgentRuntimeConfig` / `Agent.setPermissionPreset`.
   */
  networkAccess?: boolean;
  /**
   * Extra writable roots. When set, callers resolve against cwd/home
   * via {@link resolvePresetWritableRoots}.
   */
  expandMobileRoots?: boolean;
  /** Expand Vite/Next/Playwright cache roots. */
  expandWebdevRoots?: boolean;
}

/**
 * Built-in presets. Order is menu display order.
 *
 * | Preset | Sandbox | Approval | Auto-run |
 * |---|---|---|---|
 * | safe | read-only | unless-trusted | always-confirm |
 * | ask-all | workspace-write | on-request | always-confirm |
 * | approve-all | danger-full-access | never | off |
 * | mobile | workspace-write + network + SDK roots | on-request | safe-only |
 * | webdev | workspace-write + network + frontend caches | on-request | safe-only |
 *
 * Note: `mobile` and `webdev` share mode/approval/autoRun axes; hosts
 * should track the named preset (Agent.permissionPresetName) rather than
 * inferring solely from axes.
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
  {
    name: "mobile",
    permissionMode: "workspace-write",
    askForApproval: "on-request",
    autoRun: "safe-only",
    networkAccess: true,
    expandMobileRoots: true,
    label: "Mobile",
    description:
      "Workspace + network + Simulator/SDK roots for Flutter/RN/native loops",
  },
  {
    name: "webdev",
    permissionMode: "workspace-write",
    askForApproval: "on-request",
    autoRun: "safe-only",
    networkAccess: true,
    expandWebdevRoots: true,
    label: "Webdev",
    description:
      "Workspace + network + Vite/Next/Playwright caches for browser UI loops",
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

/** Resolve expandable writable roots for a preset (cwd/home aware). */
export function resolvePresetWritableRoots(
  preset: PermissionPresetResolved,
  opts: { cwd: string; homeDir?: string },
): string[] {
  const roots: string[] = [];
  if (preset.expandMobileRoots) {
    roots.push(...mobileWritableRoots(opts));
  }
  if (preset.expandWebdevRoots) {
    roots.push(...webdevWritableRoots(opts));
  }
  return roots;
}

/**
 * Find the preset that exactly matches the live policy axes, or
 * `undefined` when the mix is custom / ambiguous (e.g. mobile vs webdev).
 */
export function matchPermissionPreset(axes: {
  permissionMode: PermissionMode;
  askForApproval: AskForApproval;
  autoRun?: AutoRunPolicy;
}): PermissionPresetName | undefined {
  if (axes.autoRun !== undefined) {
    const matches = PERMISSION_PRESETS.filter(
      (p) =>
        p.permissionMode === axes.permissionMode &&
        p.askForApproval === axes.askForApproval &&
        p.autoRun === axes.autoRun,
    );
    return matches.length === 1 ? matches[0]!.name : undefined;
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
  networkAccess?: boolean;
} {
  const p = resolvePermissionPreset(name);
  return {
    permissionPreset: p.name,
    permissionMode: p.permissionMode,
    askForApproval: p.askForApproval,
    autoRun: p.autoRun,
    ...(p.networkAccess !== undefined
      ? { networkAccess: p.networkAccess }
      : {}),
  };
}
