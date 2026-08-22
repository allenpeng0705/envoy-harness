/**
 * Phase F / C1 — LandlockSandboxExecutor
 * (`@deepseek-ai/node-addon-landlock-run`).
 *
 * Fail-closed: unusable probe / missing package does not
 * run the command unconfined (unless `onUnusable: "noop"`).
 */

import { policyToLandlockGrants } from "../policy.js";
import { spawnCapture } from "./spawn-capture.js";
import type {
  SandboxContext,
  SandboxExecutor,
  SandboxResult,
} from "../types.js";

/** Injectable subset of the landlock-run entry package. */
export interface LandlockLauncherApi {
  /**
   * Returns the absolute path to the launcher binary.
   * May throw if the package is broken / not installed
   * (we treat any throw as "unavailable" and fail-closed).
   */
  launcherPath(): string;
  probe(launcher?: string): "full" | "partial" | "unusable";
  grantArgs(grants: {
    readOnly?: readonly string[];
    readWrite?: readonly string[];
  }): string[];
  /**
   * Exit code the launcher emits when it cannot apply the
   * requested restrictions. Documented on the API surface
   * so callers / tests can recognize a launcher-side
   * failure vs. a command-side failure.
   */
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

    // `launcherPath()` may throw if the launcher binary is
    // missing or the package is broken. The previous version
    // propagated the raw throw, which meant a broken install
    // surfaced as a non-sandbox-shaped error. Treat it as
    // "unavailable" and let `onUnusable` decide.
    let launcher: string;
    try {
      launcher = api.launcherPath();
    } catch (err) {
      return this.#unavailable(
        `landlock-run launcher path unavailable: ${err instanceof Error ? err.message : String(err)}`,
        command,
        context,
      );
    }

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
    return spawnCapture({
      file: launcher,
      args,
      cwd: context.cwd,
      signal: context.signal,
      ...(context.maxOutputBytes !== undefined
        ? { maxOutputBytes: context.maxOutputBytes }
        : {}),
    });
  }

  #unavailable(
    reason: string,
    command: string,
    context: SandboxContext,
  ): Promise<SandboxResult> {
    if (this.#onUnusable === "noop") {
      return spawnCapture({
        file: "sh",
        args: ["-c", command],
        cwd: context.cwd,
        signal: context.signal,
        ...(context.maxOutputBytes !== undefined
          ? { maxOutputBytes: context.maxOutputBytes }
          : {}),
      });
    }
    return Promise.resolve({
      stdout: "",
      stderr: `sandbox unavailable: ${reason}`,
      exitCode: 125,
      isError: true,
    });
  }
}

