/**
 * Phase F — pick SandboxExecutor from policy + platform.
 *
 * **Resolver contract (post-review):**
 * 1. The kernel-level sandbox is **opt-in**. A policy with
 *    `backend: "none"` always resolves to a noop executor,
 *    regardless of platform.
 * 2. `force: "landlock" | "seatbelt" | "noop"` overrides the
 *    policy (used by tests and explicit CLI flags).
 * 3. When the policy says `backend: "linux-landlock"`:
 *    - on Linux → `LandlockSandboxExecutor`
 *    - on any other platform → **noop** (do NOT silently swap
 *      to seatbelt; the user asked for landlock, so we honor
 *      the noop fallback when their chosen backend is
 *      unavailable on this host). This is the
 *      hermeticity-preserving choice: never requires a real
 *      kernel unless explicitly asked.
 * 4. `backend: "process-fs-namespace"` is reserved (no
 *    implementation in v0); resolves to noop.
 *
 * The Agent passes `force: "noop"` only when its
 * `sandboxExecutor` option is the noop executor, and the CLI
 * `--sandbox-executor <name>` flag is the user-facing opt-in.
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

export function resolveSandboxExecutor(
  options: ResolveSandboxExecutorOptions,
): SandboxExecutor {
  // Explicit `force` wins.
  if (options.force === "noop") {
    return new NoopSandboxExecutor();
  }
  if (options.force === "landlock") {
    return new LandlockSandboxExecutor(options.landlock);
  }
  if (options.force === "seatbelt") {
    return new SeatbeltSandboxExecutor(options.seatbelt);
  }

  const platform = options.platform ?? process.platform;

  // Policy-driven resolution. `backend: "none"` is the v1
  // default (validators only); opt into a kernel sandbox by
  // setting `policy.backend`.
  if (options.policy.backend === "linux-landlock") {
    if (platform === "linux") {
      return new LandlockSandboxExecutor(options.landlock);
    }
    // Linux-only backend requested on a non-Linux host: fall
    // back to noop rather than silently swap. The Agent can
    // still inject a `SandboxExecutor` via its constructor.
    return new NoopSandboxExecutor();
  }
  if (options.policy.backend === "darwin-sandbox") {
    if (platform === "darwin") {
      return new SeatbeltSandboxExecutor(options.seatbelt);
    }
    return new NoopSandboxExecutor();
  }
  // `backend: "none"` and any unknown / unimplemented value:
  // noop. The 6 bash validators are the v1 enforcement layer.
  return new NoopSandboxExecutor();
}
