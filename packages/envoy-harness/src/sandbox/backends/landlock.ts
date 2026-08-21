/**
 * Phase F / C1 — LandlockSandboxExecutor
 * (`@deepseek-ai/node-addon-landlock-run`).
 *
 * Fail-closed: unusable probe / missing package does not
 * run the command unconfined (unless `onUnusable: "noop"`).
 */

import { spawn } from "node:child_process";

import { policyToLandlockGrants } from "../policy.js";
import type {
  SandboxContext,
  SandboxExecutor,
  SandboxResult,
} from "../types.js";

/** Injectable subset of the landlock-run entry package. */
export interface LandlockLauncherApi {
  launcherPath(): string;
  probe(launcher?: string): "full" | "partial" | "unusable";
  grantArgs(grants: {
    readOnly?: readonly string[];
    readWrite?: readonly string[];
  }): string[];
  readonly LAUNCHER_FAILURE_EXIT: number;
}

export interface LandlockSandboxExecutorOptions {
  api?: LandlockLauncherApi;
  /** Default `"error"` (fail-closed). */
  onUnusable?: "noop" | "error";
}

async function loadDefaultApi(): Promise<LandlockLauncherApi | undefined> {
  try {
    return (await import(
      "@deepseek-ai/node-addon-landlock-run"
    )) as LandlockLauncherApi;
  } catch {
    return undefined;
  }
}

export class LandlockSandboxExecutor implements SandboxExecutor {
  readonly #api: LandlockLauncherApi | undefined;
  readonly #onUnusable: "noop" | "error";
  readonly #loadApi: () => Promise<LandlockLauncherApi | undefined>;

  constructor(options: LandlockSandboxExecutorOptions = {}) {
    this.#api = options.api;
    this.#onUnusable = options.onUnusable ?? "error";
    this.#loadApi = options.api
      ? async () => options.api
      : loadDefaultApi;
  }

  async execute(
    command: string,
    context: SandboxContext,
  ): Promise<SandboxResult> {
    const api = this.#api ?? (await this.#loadApi());
    if (api === undefined) {
      return this.#unavailable(
        "landlock-run package not installed",
        command,
        context,
      );
    }
    const launcher = api.launcherPath();
    if (api.probe(launcher) === "unusable") {
      return this.#unavailable(
        "landlock-run probe reported unusable",
        command,
        context,
      );
    }

    const grants = policyToLandlockGrants(context.policy, context.cwd);
    const args = [
      ...api.grantArgs({
        readOnly: grants.readOnly,
        readWrite: grants.readWrite,
      }),
      "--",
      "sh",
      "-c",
      command,
    ];
    return spawnCapture(launcher, args, context);
  }

  async #unavailable(
    reason: string,
    command: string,
    context: SandboxContext,
  ): Promise<SandboxResult> {
    if (this.#onUnusable === "noop") {
      return spawnCapture("sh", ["-c", command], context);
    }
    return {
      stdout: "",
      stderr: `sandbox unavailable: ${reason}`,
      exitCode: 125,
      isError: true,
    };
  }
}

function spawnCapture(
  file: string,
  args: readonly string[],
  context: SandboxContext,
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], {
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
