/**
 * F2b — Windows sandbox sidecar executor (`envoy-sandbox-win`).
 *
 * Spawns a long-lived sidecar process and sends newline JSON requests.
 * Falls back to {@link WindowsJobSandboxExecutor} when the sidecar binary
 * is missing (or `onUnusable: "noop"` on non-Windows for tests).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type {
  SandboxContext,
  SandboxExecutor,
  SandboxResult,
} from "../types.js";
import { WindowsJobSandboxExecutor } from "./windows-job.js";

export interface WindowsSidecarSandboxExecutorOptions {
  /** Sidecar command (default: resolve `envoy-sandbox-win`). */
  command?: string;
  /** Sidecar argv prefix (default: `[sidecarBin]`). */
  args?: string[];
  onUnusable?: "noop" | "error";
  /**
   * After sending cancel IPC, wait this many ms for the execute to settle
   * before rejecting with `aborted` (default 2000).
   */
  cancelSoftFailMs?: number;
}

export function resolveWindowsSidecarBin(): string | undefined {
  if (process.env.ENVOY_SANDBOX_WIN_BIN !== undefined) {
    return process.env.ENVOY_SANDBOX_WIN_BIN;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(
    here,
    "../../../../envoy-sandbox-win/dist/bin.js",
  );
  if (existsSync(sibling)) return sibling;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@envoymesh/envoy-sandbox-win/package.json");
    const bin = path.join(path.dirname(pkg), "dist/bin.js");
    if (existsSync(bin)) return bin;
  } catch {
    // optional package
  }
  return undefined;
}

export function isWindowsSidecarAvailable(): boolean {
  return resolveWindowsSidecarBin() !== undefined;
}

export class WindowsSidecarSandboxExecutor implements SandboxExecutor {
  readonly #command: string | undefined;
  readonly #args: string[] | undefined;
  readonly #onUnusable: "noop" | "error";
  readonly #cancelSoftFailMs: number;
  readonly #fallback = new WindowsJobSandboxExecutor({ onUnusable: "noop" });
  #child: ChildProcessWithoutNullStreams | undefined;
  #pending:
    | Map<
        string,
        {
          resolve: (r: SandboxResult) => void;
          reject: (e: Error) => void;
        }
      >
    | undefined;
  #buffer = "";

  constructor(options: WindowsSidecarSandboxExecutorOptions = {}) {
    this.#command = options.command;
    this.#args = options.args;
    this.#onUnusable = options.onUnusable ?? "error";
    this.#cancelSoftFailMs = options.cancelSoftFailMs ?? 2_000;
  }

  async execute(
    command: string,
    context: SandboxContext,
  ): Promise<SandboxResult> {
    const bin = this.#command ?? resolveWindowsSidecarBin();
    if (bin === undefined) {
      if (this.#onUnusable === "noop") {
        return this.#fallback.execute(command, context);
      }
      return {
        stdout: "",
        stderr: "envoy-sandbox-win sidecar not found",
        exitCode: 125,
        isError: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }

    try {
      await this.#ensureChild(bin);
      const id = randomUUID();
      const req = {
        id,
        method: "execute" as const,
        params: {
          command,
          cwd: context.cwd,
          policy: context.policy,
          ...(context.maxOutputBytes !== undefined
            ? { maxOutputBytes: context.maxOutputBytes }
            : {}),
        },
      };
      const result = await this.#request(req, context.signal);
      return result;
    } catch (err) {
      if (this.#onUnusable === "noop") {
        return this.#fallback.execute(command, context);
      }
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 125,
        isError: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }
  }

  async #ensureChild(bin: string): Promise<void> {
    if (this.#child !== undefined && !this.#child.killed) return;
    const isJs = bin.endsWith(".js");
    const command = isJs ? process.execPath : bin;
    const spawnArgs = isJs ? [bin] : (this.#args ?? []);
    const child = spawn(command, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.#child = child;
    this.#pending = new Map();
    this.#buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let idx: number;
      while ((idx = this.#buffer.indexOf("\n")) !== -1) {
        const line = this.#buffer.slice(0, idx).trim();
        this.#buffer = this.#buffer.slice(idx + 1);
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line) as {
            id: string;
            ok: boolean;
            result?: SandboxResult;
            error?: string;
          };
          const waiter = this.#pending?.get(parsed.id);
          if (waiter === undefined) continue;
          this.#pending?.delete(parsed.id);
          if (!parsed.ok || parsed.result === undefined) {
            waiter.reject(new Error(parsed.error ?? "sidecar error"));
          } else {
            waiter.resolve(parsed.result);
          }
        } catch {
          // ignore malformed lines
        }
      }
    });
    child.on("error", () => this.#resetChild());
    child.on("close", () => this.#resetChild());
  }

  #resetChild(): void {
    if (this.#pending !== undefined) {
      for (const waiter of this.#pending.values()) {
        waiter.reject(new Error("sidecar exited"));
      }
    }
    this.#pending = undefined;
    this.#child = undefined;
  }

  #request(
    req: { id: string; method: string; params: unknown },
    signal: AbortSignal | undefined,
  ): Promise<SandboxResult> {
    const child = this.#child;
    const pending = this.#pending;
    if (child === undefined || pending === undefined) {
      return Promise.reject(new Error("sidecar not running"));
    }
    return new Promise<SandboxResult>((resolve, reject) => {
      pending.set(req.id, { resolve, reject });
      const onAbort = (): void => {
        // R6.3 — cancel the in-flight execute; keep the sidecar alive.
        try {
          child.stdin.write(
            JSON.stringify({
              id: randomUUID(),
              method: "cancel",
              params: { id: req.id },
            }) + "\n",
          );
        } catch {
          // stdin may be closed; fall through to reject
        }
        // Wait for the execute response (aborted child close) if still
        // pending; otherwise reject immediately if already removed.
        const waiter = pending.get(req.id);
        if (waiter !== undefined) {
          // Soft-fail path: if cancel response never maps, reject soon.
          setTimeout(() => {
            const still = pending.get(req.id);
            if (still !== undefined) {
              pending.delete(req.id);
              still.reject(new Error("aborted"));
            }
          }, this.#cancelSoftFailMs);
        }
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.write(JSON.stringify(req) + "\n", (err) => {
        if (err !== undefined && err !== null) {
          signal?.removeEventListener("abort", onAbort);
          pending.delete(req.id);
          reject(err);
        }
      });
    });
  }
}
