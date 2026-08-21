/**
 * bash — the workhorse tool for running shell commands.
 *
 * **Design doc:** `docs/design.md` §6 (permissions) + §10 (tools).
 *
 * **Permission validation:** every command is run through
 * `validateBash` (§6.2 — the 6-validator composition) using the
 * session's `permissionMode`. A blocked command never reaches
 * the shell; the tool returns `isError: true` with the validator
 * reason. A warned command runs; the model sees the warning in
 * the result so it can adjust.
 *
 * **Why we re-validate here (not just at the agent boundary):**
 * the bash tool is the chokepoint for "execute a command". Even
 * if a future chunk adds a new path to invoke bash (e.g. via a
 * sub-agent or a hook that reschedules commands), every invocation
 * goes through `validateBash`. No back door.
 *
 * **Sandbox:** v0 runs the command in `sh -c` with the same
 * permission system as the user. Phase 2 (mesh-native) adds a
 * real sandbox (Landlock / nsjail / Docker). The tool's signature
 * stays the same; only the spawn call changes.
 *
 * **Timeout:** default 30s, configurable via `timeoutMs`. The
 * agent's `abortSignal` is also honored (user-initiated cancel
 * kills the child). `SIGKILL` for hard-kill (a hung shell can't
 * be politely asked to exit).
 *
 * **Background (`background: true`):** when a {@link JobRegistry}
 * is bound via {@link makeBashTool}, the command is started as a
 * job and the tool returns the job id immediately.
 */

import { spawn } from "node:child_process";

import { z } from "zod";

import {
  createProcessJobHooks,
  type JobRegistry,
} from "../../jobs/index.js";
import { validateBash } from "../../permissions/bash/index.js";
import { tokenizeShellCommand } from "../../permissions/bash/tokenize.js";
import { policyFromMode } from "../../permissions/policy.js";
import type { BashValidationInput, SandboxPolicy } from "../../types.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

/** Default timeout for a bash command, in milliseconds. */
const DEFAULT_BASH_TIMEOUT_MS = 30_000;

/** Maximum bytes captured per stream (stdout/stderr). */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

const bashParameters = z.object({
  command: z.string().describe("The shell command to run"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Timeout in milliseconds (default 30000)"),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum bytes to capture per stream (default 1 MB)"),
  background: z
    .boolean()
    .optional()
    .describe(
      "When true and jobs are wired, start as a background job and return the job id",
    ),
});

type BashParams = z.infer<typeof bashParameters>;

export interface MakeBashToolOptions {
  /** When set, `background: true` starts a job instead of blocking. */
  jobs?: JobRegistry;
}

/**
 * Build a bash tool. Pass `{ jobs }` to enable `background: true`
 * sugar that returns a job id immediately.
 */
export function makeBashTool(options: MakeBashToolOptions = {}): Tool<
  typeof bashParameters
> {
  const jobs = options.jobs;

  return {
    name: "bash",
    description:
      "Run a shell command and return its stdout, stderr, and exit code. " +
      "The command is validated against the session's permission mode " +
      "(read-only / workspace-write / danger-full-access). Blocked " +
      "commands return isError: true without running. Use `timeoutMs` " +
      "(default 30000) and `maxOutputBytes` (default 1 MB) to cap " +
      "very long-running or verbose commands." +
      (jobs !== undefined
        ? " Set `background: true` to start the command as a job and return its id immediately."
        : ""),
    parameters: bashParameters,
    async execute(args, ctx): Promise<ToolResult> {
      return executeBash(args, ctx, jobs);
    },
  };
}

/**
 * Default bash tool (no job registry). Prefer
 * {@link makeBashTool} when wiring environment capabilities.
 */
export const bashTool: Tool<typeof bashParameters> = makeBashTool();

async function executeBash(
  args: BashParams,
  ctx: ToolContext,
  jobs: JobRegistry | undefined,
): Promise<ToolResult> {
  const { command, timeoutMs, maxOutputBytes, background } = args;
  const mode = ctx.session.metadata.permissionMode ?? "read-only";
  const policy: SandboxPolicy = ctx.sandboxPolicy ?? policyFromMode(mode, ctx.cwd);

  const input: BashValidationInput = {
    command,
    argv: tokenizeShellCommand(command),
    env: envRecord(),
    cwd: ctx.cwd,
    policy,
  };
  const verdict = await validateBash(input);
  if (verdict.kind === "block") {
    return {
      content: `bash blocked: ${verdict.reason}`,
      isError: true,
    };
  }

  const warning =
    verdict.kind === "allow-with-warning" ? verdict.warning : undefined;

  if (background === true) {
    if (jobs === undefined) {
      return {
        content:
          "bash background: true requires a job registry (wireEnvironmentTools)",
        isError: true,
      };
    }
    const id = jobs.start({
      kind: "bash",
      label: command,
      ...(maxOutputBytes !== undefined
        ? { outputLimitBytes: maxOutputBytes }
        : {}),
      owner: ctx.session.id,
      run: () =>
        createProcessJobHooks({
          command,
          cwd: ctx.cwd,
          ...(maxOutputBytes !== undefined
            ? { outputLimitBytes: maxOutputBytes }
            : {}),
        }),
    });
    const snap = jobs.get(id, ctx.session.id);
    const payload: Record<string, unknown> = {
      id,
      kind: snap.kind,
      label: snap.label,
      status: snap.status,
      startedAt: snap.startedAt,
    };
    if (warning !== undefined) payload.warning = warning;
    return { content: JSON.stringify(payload) };
  }

  return runBash(command, ctx, timeoutMs, maxOutputBytes, warning);
}

/** Convert `process.env` to a `Record<string, string>` (filtering undefined). */
function envRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Spawn `sh -c <command>` (or the configured sandbox executor)
 * and collect stdout/stderr/exitCode.
 *
 * @param preWarning - if set, prefixed to the result so the model
 *   sees the warning. Comes from `validateBash`'s warn verdict.
 */
async function runBash(
  command: string,
  ctx: ToolContext,
  timeoutMs: number | undefined,
  maxOutputBytes: number | undefined,
  preWarning: string | undefined,
): Promise<{ content: string; isError?: boolean }> {
  const timeout = timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const cap = maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  if (ctx.sandboxExecutor !== undefined) {
    return runBashViaExecutor(command, ctx, timeout, cap, preWarning);
  }

  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeout);

    const onAbort = () => {
      killed = true;
      child.kill("SIGKILL");
    };
    if (ctx.abortSignal.aborted) {
      onAbort();
    } else {
      ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length + d.length > cap) {
        stdoutTruncated = true;
        stdout += d.toString("utf8", 0, Math.max(0, cap - stdout.length));
      } else {
        stdout += d.toString("utf8");
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length + d.length > cap) {
        stderrTruncated = true;
        stderr += d.toString("utf8", 0, Math.max(0, cap - stderr.length));
      } else {
        stderr += d.toString("utf8");
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener("abort", onAbort);
      resolve(
        formatBashResult({
          stdout,
          stderr,
          exitCode: code,
          stdoutTruncated,
          stderrTruncated,
          killed,
          cap,
          preWarning,
        }),
      );
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener("abort", onAbort);
      resolve({
        content: `bash spawn error: ${err.message}`,
        isError: true,
      });
    });
  });
}

async function runBashViaExecutor(
  command: string,
  ctx: ToolContext,
  timeoutMs: number,
  cap: number,
  preWarning: string | undefined,
): Promise<{ content: string; isError?: boolean }> {
  const executor = ctx.sandboxExecutor!;
  const policy =
    ctx.sandboxPolicy ??
    policyFromMode(ctx.session.metadata.permissionMode ?? "read-only", ctx.cwd);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = (): void => ac.abort();
  if (ctx.abortSignal.aborted) ac.abort();
  else ctx.abortSignal.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await executor.execute(command, {
      policy,
      cwd: ctx.cwd,
      signal: ac.signal,
    });
    const stdout =
      result.stdout.length > cap ? result.stdout.slice(0, cap) : result.stdout;
    const stderr =
      result.stderr.length > cap ? result.stderr.slice(0, cap) : result.stderr;
    return formatBashResult({
      stdout,
      stderr,
      exitCode: result.exitCode,
      stdoutTruncated: result.stdout.length > cap,
      stderrTruncated: result.stderr.length > cap,
      killed: ac.signal.aborted,
      cap,
      preWarning,
    });
  } catch (err) {
    return {
      content: `bash sandbox error: ${(err as Error).message}`,
      isError: true,
    };
  } finally {
    clearTimeout(timer);
    ctx.abortSignal.removeEventListener("abort", onAbort);
  }
}

function formatBashResult(opts: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  killed: boolean;
  cap: number;
  preWarning: string | undefined;
}): { content: string; isError?: boolean } {
  const parts: string[] = [];
  if (opts.preWarning) parts.push(`[warning] ${opts.preWarning}\n`);
  if (opts.stdout.length > 0) {
    parts.push(opts.stdout);
    if (opts.stdoutTruncated) {
      parts.push(`\n[stdout truncated at ${opts.cap} bytes]`);
    }
  }
  if (opts.stderr.length > 0) {
    parts.push(`\n[stderr]\n${opts.stderr}`);
    if (opts.stderrTruncated) {
      parts.push(`\n[stderr truncated at ${opts.cap} bytes]`);
    }
  }
  parts.push(`\n[exit code: ${opts.exitCode ?? "null"}]`);
  if (opts.killed) parts.push(`\n[command was killed]`);
  return { content: parts.join(""), isError: opts.exitCode !== 0 };
}
