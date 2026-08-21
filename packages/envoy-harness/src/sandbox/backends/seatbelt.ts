/**
 * Phase F / C2 — SeatbeltSandboxExecutor (`sandbox-exec` on macOS).
 */

import { spawn } from "node:child_process";

import { policyToSeatbeltProfile } from "../policy.js";
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
    if (context.policy.backend === "none") {
      return spawnSh(command, context);
    }
    const profile = policyToSeatbeltProfile(context.policy, context.cwd);
    return new Promise((resolve) => {
      const child = spawn(
        this.#binary,
        ["-p", profile, "sh", "-c", command],
        {
          cwd: context.cwd,
          signal: context.signal,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => out.push(c));
      child.stderr?.on("data", (c: Buffer) => err.push(c));
      child.on("close", (code) => {
        resolve({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          exitCode: code ?? 1,
          isError: code !== 0,
        });
      });
      child.on("error", (e) => {
        if (this.#onUnusable === "noop") {
          void spawnSh(command, context).then(resolve);
          return;
        }
        resolve({
          stdout: "",
          stderr: `sandbox unavailable: ${e.message}`,
          exitCode: 125,
          isError: true,
        });
      });
    });
  }
}

function spawnSh(
  command: string,
  context: SandboxContext,
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd: context.cwd,
      signal: context.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: code ?? 1,
        isError: code !== 0,
      });
    });
    child.on("error", (e) => {
      resolve({
        stdout: "",
        stderr: e.message,
        exitCode: 1,
        isError: true,
      });
    });
  });
}
