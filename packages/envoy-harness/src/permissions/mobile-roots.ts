/**
 * Writable roots + helpers for the `mobile` permission preset
 * (iOS Simulator / Android SDK trees + project build dirs).
 */

import * as os from "node:os";
import * as path from "node:path";

/** Env override that unlocks `device_*` tools without the mobile preset. */
export const ENVOY_MOBILE_TOOLS_ENV = "ENVOY_MOBILE_TOOLS";

/**
 * Typical Simulator / Android SDK / AVD / project build paths.
 * Expanded into `writableRoots` when `permissionPreset = "mobile"`.
 */
export function mobileWritableRoots(opts: {
  cwd: string;
  homeDir?: string;
}): string[] {
  const home = opts.homeDir ?? os.homedir();
  const androidHome =
    process.env["ANDROID_HOME"] ??
    process.env["ANDROID_SDK_ROOT"] ??
    path.join(home, "Library", "Android", "sdk");
  const androidUserHome =
    process.env["ANDROID_USER_HOME"] ?? path.join(home, ".android");
  return [
    path.join(home, "Library", "Developer", "CoreSimulator"),
    path.join(home, "Library", "Developer", "Xcode"),
    path.join(home, "Library", "Developer", "XCTestDevices"),
    androidHome,
    androidUserHome,
    path.join(androidUserHome, "avd"),
    path.join(opts.cwd, "build"),
    path.join(opts.cwd, "android", "app", "build"),
    path.join(opts.cwd, "ios", "build"),
    path.join(opts.cwd, ".dart_tool"),
  ];
}

/**
 * True when a root looks like a mobile SDK / Simulator path.
 *
 * Deliberately does **not** treat a bare project cwd named `build`
 * (or any path that merely ends in `/build`) as mobile — that would
 * unlock `device_*` under default workspace-write. Project build dirs
 * only count when they sit under a known mobile layout
 * (`android/…/build`, `ios/build`) or when CoreSimulator / Android SDK
 * markers are present.
 */
export function isMobileWritableRoot(root: string): boolean {
  const normalized = root.replace(/\\/g, "/").toLowerCase();
  if (
    normalized.includes("coresimulator") ||
    normalized.includes("/library/developer/xcode") ||
    normalized.includes("/library/developer/xctestdevices") ||
    normalized.includes("/android/sdk") ||
    normalized.includes("/.android") ||
    normalized.includes("/avd") ||
    normalized.includes("/.dart_tool")
  ) {
    return true;
  }
  // Project-relative mobile build trees only (not cwd === ".../build").
  if (
    /\/android\/(?:app\/)?build\/?$/.test(normalized) ||
    /\/ios\/build\/?$/.test(normalized)
  ) {
    return true;
  }
  return false;
}

/**
 * Gate for first-party `device_*` tools: mobile preset roots,
 * danger-full-access, or explicit `ENVOY_MOBILE_TOOLS=1`.
 */
export function isMobileDeviceAccessAllowed(policy?: {
  mode?: string;
  networkAccess?: boolean;
  writableRoots?: ReadonlyArray<string>;
}): boolean {
  if (process.env[ENVOY_MOBILE_TOOLS_ENV] === "1") return true;
  if (policy?.mode === "danger-full-access") return true;
  const roots = policy?.writableRoots ?? [];
  if (roots.some((r) => isMobileWritableRoot(r))) return true;
  return false;
}
