/**
 * Phase F — pick SandboxExecutor from policy + platform.
 */

import type { SandboxPolicy } from "../types.js";
import { LandlockSandboxExecutor } from "./backends/landlock.js";
import { SeatbeltSandboxExecutor } from "./backends/seatbelt.js";
import { NoopSandboxExecutor, type SandboxExecutor } from "./types.js";

export interface ResolveSandboxExecutorOptions {
  policy: SandboxPolicy;
  platform?: NodeJS.Platform;
  force?: "landlock" | "seatbelt" | "noop";
  landlock?: ConstructorParameters<typeof LandlockSandboxExecutor>[0];
  seatbelt?: ConstructorParameters<typeof SeatbeltSandboxExecutor>[0];
}

/**
 * - `backend: "none"` → noop
 * - Linux → landlock
 * - Darwin → seatbelt
 * - else → noop (Windows: validators only for now)
 */
export function resolveSandboxExecutor(
  options: ResolveSandboxExecutorOptions,
): SandboxExecutor {
  if (options.force === "noop" || options.policy.backend === "none") {
    return new NoopSandboxExecutor();
  }
  if (options.force === "landlock") {
    return new LandlockSandboxExecutor(options.landlock);
  }
  if (options.force === "seatbelt") {
    return new SeatbeltSandboxExecutor(options.seatbelt);
  }

  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    return new LandlockSandboxExecutor(options.landlock);
  }
  if (platform === "darwin") {
    return new SeatbeltSandboxExecutor(options.seatbelt);
  }
  return new NoopSandboxExecutor();
}
