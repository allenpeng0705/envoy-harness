/**
 * Mobile permission preset expands network + SDK/Simulator roots.
 */

import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAgentRuntimeConfig } from "../../src/config/apply.js";
import {
  isMobileDeviceAccessAllowed,
  mobileWritableRoots,
  resolvePermissionPreset,
} from "../../src/permissions/index.js";

describe("mobile permission preset", () => {
  it("resolves axes + network + expandMobileRoots", () => {
    const preset = resolvePermissionPreset("mobile");
    expect(preset.permissionMode).toBe("workspace-write");
    expect(preset.askForApproval).toBe("on-request");
    expect(preset.autoRun).toBe("safe-only");
    expect(preset.networkAccess).toBe(true);
    expect(preset.expandMobileRoots).toBe(true);
  });

  it("resolveAgentRuntimeConfig expands roots and network", () => {
    const cwd = "/tmp/app";
    const resolved = resolveAgentRuntimeConfig(cwd, {
      permissionPreset: "mobile",
    });
    expect(resolved.permissionMode).toBe("workspace-write");
    expect(resolved.sandboxPolicy.networkAccess).toBe(true);
    const roots = resolved.sandboxPolicy.writableRoots;
    expect(roots.some((r) => r.includes("CoreSimulator"))).toBe(true);
    expect(roots.some((r) => r === path.join(cwd, "build"))).toBe(true);
    expect(isMobileDeviceAccessAllowed(resolved.sandboxPolicy)).toBe(true);
  });

  it("mobileWritableRoots includes ANDROID_HOME when set", () => {
    const prev = process.env["ANDROID_HOME"];
    process.env["ANDROID_HOME"] = "/opt/android-sdk";
    try {
      const roots = mobileWritableRoots({
        cwd: "/tmp/p",
        homeDir: os.homedir(),
      });
      expect(roots).toContain("/opt/android-sdk");
    } finally {
      if (prev === undefined) delete process.env["ANDROID_HOME"];
      else process.env["ANDROID_HOME"] = prev;
    }
  });

  it("does not treat a bare .../build cwd as mobile", async () => {
    const { isMobileWritableRoot, isMobileDeviceAccessAllowed } = await import(
      "../../src/permissions/mobile-roots.js"
    );
    expect(isMobileWritableRoot("/Users/dev/build")).toBe(false);
    expect(
      isMobileDeviceAccessAllowed({
        mode: "workspace-write",
        networkAccess: false,
        writableRoots: ["/Users/dev/build"],
      }),
    ).toBe(false);
    expect(isMobileWritableRoot("/tmp/app/android/app/build")).toBe(true);
    expect(isMobileWritableRoot("/x/Library/Developer/CoreSimulator")).toBe(
      true,
    );
  });
});
