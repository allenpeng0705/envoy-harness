/**
 * Phase F / C2 — SeatbeltSandboxExecutor (`sandbox-exec` on macOS).
 */

import { accessSync, constants as fsConstants } from "node:fs";

import { policyToSeatbeltProfile } from "../policy.js";
import { spawnCapture } from "./spawn-capture.js";
import type {
  SandboxContext,
  SandboxExecutor,
  SandboxResult,
} from "../types.js";

export interface SeatbeltSandboxExecutorOptions {
  binary?: string;
  onUnusable?: "noop" | "error";
}

export class SeatbeltSandboxExecutor implements SandboxExecutor {
  readonly #binary: string;
  readonly #onUnusable: "noop" | "error";

  constructor(options: SeatbeltSandboxExecutorOptions = {}) {
    this.#binary = options.binary ?? "sandbox-exec";
    this.#onUnusable = options.onUnusable ?? "error";
  }

  async execute(
    command: string,
    context: SandboxContext,
  ): Promise<SandboxResult> {
    const captureOpts = {
      cwd: context.cwd,
      signal: context.signal,
      ...(context.maxOutputBytes !== undefined
        ? { maxOutputBytes: context.maxOutputBytes }
        : {}),
    };
    if (context.policy.backend === "none") {
      return spawnCapture({
        file: "sh",
        args: ["-c", command],
        ...captureOpts,
      });
    }
    // Pre-flight existence check. If the binary is missing
    // (typical on Linux / CI), honor `onUnusable` instead of
    // letting the spawn fail with a generic ENOENT.
    if (!SeatbeltSandboxExecutor.#binaryAvailable(this.#binary)) {
      if (this.#onUnusable === "noop") {
        return spawnCapture({
          file: "sh",
          args: ["-c", command],
          ...captureOpts,
        });
      }
      return {
        stdout: "",
        stderr: `sandbox unavailable: ${this.#binary} not found`,
        exitCode: 125,
        isError: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }
    const profile = policyToSeatbeltProfile(context.policy, context.cwd);
    return spawnCapture({
      file: this.#binary,
      args: ["-p", profile, "sh", "-c", command],
      ...captureOpts,
    });
  }

  /** Sync check; cheap. `sandbox-exec` is a system binary. */
  static #binaryAvailable(binary: string): boolean {
    if (binary.includes("/")) {
      // Absolute or relative path: must exist + be executable.
      try {
        accessSync(binary, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
    // Bare name: rely on PATH resolution at spawn time. We do
    // a soft check that doesn't hit $PATH; the spawn will
    // surface ENOENT if it's actually missing.
    return true;
  }
}

