/**
 * Host CLI runner for mobile device tools (simctl / adb / flutter / …).
 */

import { spawn } from "node:child_process";

export interface HostCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface HostCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * When true, do not kill the child on timeout — used to kick off
   * long-lived processes (Android emulator) that must keep running.
   * The promise still settles after `timeoutMs` (or immediately when
   * omitted) so the tool can proceed to wait-for-device.
   */
  detach?: boolean;
}

export type HostCommandRunner = (
  argv: ReadonlyArray<string>,
  opts?: HostCommandOptions,
) => Promise<HostCommandResult>;

/** Default spawn-based runner. Injectable for unit tests. */
export const defaultHostCommandRunner: HostCommandRunner = async (
  argv,
  opts = {},
) => {
  if (argv.length === 0) {
    return { code: 1, stdout: "", stderr: "", error: "empty argv" };
  }
  const [cmd, ...args] = argv;
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(cmd!, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: opts.detach
        ? ["ignore", "ignore", "ignore"]
        : ["ignore", "pipe", "pipe"],
      detached: opts.detach === true,
    });
    if (opts.detach) {
      // Allow the parent tool turn to finish without keeping the emulator
      // in the agent's process group.
      child.unref();
    }
    const chunksOut: Buffer[] = [];
    const chunksErr: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunksOut.push(c));
    child.stderr?.on("data", (c: Buffer) => chunksErr.push(c));

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!opts.detach) {
          child.kill("SIGTERM");
        }
        if (!settled) {
          settled = true;
          if (opts.detach) {
            resolve({
              code: 0,
              stdout: Buffer.concat(chunksOut).toString("utf8"),
              stderr: Buffer.concat(chunksErr).toString("utf8"),
            });
          } else {
            resolve({
              code: null,
              stdout: Buffer.concat(chunksOut).toString("utf8"),
              stderr: Buffer.concat(chunksErr).toString("utf8"),
              error: `timed out after ${opts.timeoutMs}ms`,
            });
          }
        }
      }, opts.timeoutMs);
    } else if (opts.detach) {
      // Detached kick-off with no wait: settle once spawn succeeds.
      settled = true;
      resolve({ code: 0, stdout: "", stderr: "" });
    }

    const onAbort = (): void => {
      if (!opts.detach) {
        child.kill("SIGTERM");
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const code =
        "code" in err && typeof (err as NodeJS.ErrnoException).code === "string"
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      resolve({
        code: 1,
        stdout: Buffer.concat(chunksOut).toString("utf8"),
        stderr: Buffer.concat(chunksErr).toString("utf8"),
        error:
          code === "ENOENT"
            ? `command not found: ${cmd} (install Xcode CLT / Android SDK / Flutter as needed)`
            : err.message,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout: Buffer.concat(chunksOut).toString("utf8"),
        stderr: Buffer.concat(chunksErr).toString("utf8"),
      });
    });
  });
};

let activeRunner: HostCommandRunner = defaultHostCommandRunner;

/** Override the host runner (tests). */
export function setHostCommandRunner(runner: HostCommandRunner | undefined): void {
  activeRunner = runner ?? defaultHostCommandRunner;
}

export function getHostCommandRunner(): HostCommandRunner {
  return activeRunner;
}

export async function runHostCommand(
  argv: ReadonlyArray<string>,
  opts?: HostCommandOptions,
): Promise<HostCommandResult> {
  return activeRunner(argv, opts);
}
