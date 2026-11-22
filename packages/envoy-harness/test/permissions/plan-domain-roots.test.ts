/**
 * Plan/review force read-only but must keep webdev/mobile domain roots
 * so browser_* and device_* gates stay open under those presets.
 */

import { describe, expect, it } from "vitest";

import {
  isMobileDeviceAccessAllowed,
  isWebBrowserAccessAllowed,
  policyFromMode,
  readOnlyPolicyPreservingDomainRoots,
  resolvePermissionPreset,
  resolvePresetWritableRoots,
} from "../../src/index.js";

describe("readOnlyPolicyPreservingDomainRoots", () => {
  it("keeps webdev roots + network under plan-style read-only", () => {
    const preset = resolvePermissionPreset("webdev");
    const live = {
      ...policyFromMode(preset.permissionMode, "/tmp/spa"),
      networkAccess: true,
      writableRoots: [
        "/tmp/spa",
        ...resolvePresetWritableRoots(preset, { cwd: "/tmp/spa" }),
      ],
    };
    const forced = readOnlyPolicyPreservingDomainRoots(live, "/tmp/spa");
    expect(forced.mode).toBe("read-only");
    expect(forced.writableRoots).not.toContain("/tmp/spa");
    expect(isWebBrowserAccessAllowed(forced)).toBe(true);
    expect(forced.networkAccess).toBe(true);
  });

  it("keeps mobile roots under plan-style read-only", () => {
    const preset = resolvePermissionPreset("mobile");
    const live = {
      ...policyFromMode(preset.permissionMode, "/tmp/app"),
      networkAccess: true,
      writableRoots: [
        "/tmp/app",
        ...resolvePresetWritableRoots(preset, { cwd: "/tmp/app" }),
      ],
    };
    const forced = readOnlyPolicyPreservingDomainRoots(live, "/tmp/app");
    expect(forced.mode).toBe("read-only");
    expect(isMobileDeviceAccessAllowed(forced)).toBe(true);
  });

  it("bare workspace-write without domain roots stays gated off", () => {
    const live = policyFromMode("workspace-write", "/tmp/spa");
    const forced = readOnlyPolicyPreservingDomainRoots(live, "/tmp/spa");
    expect(forced.writableRoots).toEqual([]);
    expect(isWebBrowserAccessAllowed(forced)).toBe(false);
    expect(isMobileDeviceAccessAllowed(forced)).toBe(false);
  });
});
