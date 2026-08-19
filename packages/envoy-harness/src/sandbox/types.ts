/**
 * OS sandbox — types and the executor interface.
 *
 * **Design:** §5.2 / §7. v0 ships the *six bash
 * validators* (permission/syntax/path/redirect/
 * destructive/quote), which enforce the policy at
 * the command-parse level. The OS sandbox is a
 * second layer of enforcement — kernel-level
 * (landlock, namespace) — that wraps the actual
 * command execution.
 *
 * **T3.4 scope:** the *seam* only. v0 ships:
 * - `SandboxExecutor` interface
 * - `NoopSandboxExecutor` (default; the bash tool
 *   still uses the 6 validators but no kernel
 *   enforcement)
 *
 * The `LandlockSandboxExecutor` (Linux 5.13+) and
 * the `ProcessNamespaceSandboxExecutor` (POSIX,
 * needs CAP_SYS_ADMIN or unshare(1)) land in
 * follow-up sub-chunks T3.4.1 and T3.4.2. They
 * require a Linux test environment to validate
 * the actual kernel enforcement; shipping them
 * without a Linux test would be a lie about what
 * we can prove.
 *
 * **Why ship the seam first:** the bash tool
 * already has the seam (`sandboxPolicy` is in
 * `ToolContext`; `ToolRegistry` already has 6
 * validators; the gap is the kernel-level
 * executor). A small `SandboxExecutor` interface
 * + a noop default lands the shape; the landlock
 * impl drops in as a back-end detail (the bash
 * tool doesn't change).
 */
import type { SandboxPolicy } from "../types.js";

/**
 * The context a `SandboxExecutor.execute` sees.
 * The executor decides what to allow (filesystem
 * paths, network, etc.) based on the policy.
 */
export interface SandboxContext {
  /**
   * The current sandbox policy. The executor maps
   * `mode`, `backend`, `writableRoots`, and
   * `networkAccess` to kernel-level rules (e.g.
   * landlock FS rules, namespace bind mounts).
   */
  readonly policy: SandboxPolicy;
  /**
   * The working directory for the command. The
   * executor's default `cwd` for the spawned
   * subprocess (the bash tool sets this to
   * `ctx.cwd`, which is the agent's cwd).
   */
  readonly cwd: string;
  /**
   * The abort signal. The executor forwards this
   * to the spawned subprocess (so the bash tool's
   * abort semantics work the same way).
   */
  readonly signal: AbortSignal;
}

/**
 * The result of a `SandboxExecutor.execute` call.
 * The executor may wrap the subprocess (so it sees
 * the wrapped stdout/stderr/exitCode) or run the
 * command directly (so it sees the raw output).
 *
 * v0 only ships the direct case (`NoopSandboxExecutor`).
 * The wrapping case (landlock/namespace) lands with
 * the kernel backends.
 */
export interface SandboxResult {
  /** The captured stdout (UTF-8). */
  stdout: string;
  /** The captured stderr (UTF-8). */
  stderr: string;
  /** The exit code of the wrapped (or unwrapped) command. */
  exitCode: number;
  /** If true, the sandbox itself rejected the command. */
  isError: boolean;
}

/**
 * The executor interface. The bash tool calls
 * `execute(command, context)` when a `sandboxExecutor`
 * is configured on the agent; the 6 bash validators
 * run first (as today), and the executor is the
 * second layer.
 *
 * **Why a second layer:** the validators work at
 * the command-parse level. They miss:
 * - File writes via an interpreter (`python -c
 *   'open("/etc/passwd","w")...'` — the
 *   interpreters are blocked at the wrapper level,
 *   but a determined user can find an unblocked
 *   one).
 * - Native file ops the bash tool doesn't see
 *   (e.g. a hook on the bash tool can edit a
 *   sub-process's args, but can't catch a
 *   `tee(1)` call).
 * The kernel sandbox (landlock: deny write to
 * `/etc`) catches these as a final filter.
 */
export interface SandboxExecutor {
  /**
   * Run the command under the sandbox. Returns
   * the captured output + exit code. Throws on
   * sandbox infrastructure failure (e.g. landlock
   * ruleset construction failed); these are
   * programming bugs, not user errors.
   */
  execute(command: string, context: SandboxContext): Promise<SandboxResult>;
}

/**
 * The default `SandboxExecutor` — passes the
 * command through to the bash tool's normal
 * spawn. The 6 bash validators already ran
 * (the bash tool doesn't bypass them); this
 * executor just runs the command in the same
 * process tree as the harness.
 *
 * **Why a noop at all:** the bash tool's code path
 * differs based on whether a `sandboxExecutor` is
 * set. The noop ensures the default behavior is
 * identical to v0 (no sandbox enforcement layer).
 * A future landlock/namespace executor is a
 * drop-in replacement — the bash tool calls the
 * same method, the executor decides whether to
 * wrap the spawn.
 */
export class NoopSandboxExecutor implements SandboxExecutor {
  /**
   * Wraps a raw `child_process.spawn` and
   * captures stdout/stderr/exitCode. The
   * bash tool owns the actual command logic;
   * this executor just runs the supplied
   * command in a child process and reports the
   * result. The 6 bash validators already
   * approved the command; this is the
   * "no kernel sandbox" fallback.
   */
  async execute(
    command: string,
    context: SandboxContext,
  ): Promise<SandboxResult> {
    // Dynamic import to keep the bash tool's
    // startup path light (Node's child_process
    // is a built-in; no need to import it for
    // the noop case).
    const { spawn } = await import("node:child_process");
    return new Promise<SandboxResult>((resolve) => {
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
      child.on("error", (err) => {
        resolve({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          isError: true,
        });
      });
    });
  }
}
