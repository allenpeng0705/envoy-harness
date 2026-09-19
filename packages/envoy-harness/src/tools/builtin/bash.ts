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

import { captureChildIdentity, reapChild } from "../../process/reaper.js";
import {
  classifySandboxFailure,
  formatSandboxFailure,
  isSandboxDenial,
  policyToViolationBackend,
  type SandboxFailure,
} from "../../sandbox/classify.js";
import { widenSandboxPolicy } from "../../sandbox/escalation.js";
import {
  createProcessJobHooks,
  type JobRegistry,
} from "../../jobs/index.js";
import type { SandboxResult } from "../../sandbox/types.js";
import { validateBash } from "../../permissions/bash/index.js";
import { tokenizeShellCommand } from "../../permissions/bash/tokenize.js";
import { policyFromMode } from "../../permissions/policy.js";
import type { BashValidationInput, SandboxPolicy } from "../../types.js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolResultMeta,
} from "../types.js";
import { retainHeadBytes } from "../../util/retention.js";

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
    env: ctx.shellEnv ?? envRecord(),
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
    if (ctx.execWorld !== undefined && ctx.execWorld.target.kind === "peer") {
      return {
        content:
          "bash background: true is not supported on peer exec-world (R4.14b); run foreground or use local jobs",
        isError: true,
      };
    }
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
          ...(ctx.shellEnv !== undefined ? { env: ctx.shellEnv } : {}),
          ...(maxOutputBytes !== undefined
            ? { outputLimitBytes: maxOutputBytes }
            : {}),
          ...(ctx.onToolOutput !== undefined
            ? { onOutput: ctx.onToolOutput }
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
): Promise<ToolResult> {
  const timeout = timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const cap = maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  if (ctx.execWorld !== undefined) {
    try {
      const result = await ctx.execWorld.runShell(
        {
          command,
          cwd: ctx.cwd,
          ...(ctx.shellEnv !== undefined ? { env: ctx.shellEnv } : {}),
          timeoutMs: timeout,
        },
        ctx.abortSignal,
      );
      let out = "";
      if (preWarning !== undefined) out += `warning: ${preWarning}\n`;
      if (result.timedOut) {
        out += `bash timed out after ${timeout}ms\n`;
      }
      // Byte-accurate, UTF-8-safe cut. A code-unit `slice` here could
      // split a surrogate pair and put a lone surrogate in the
      // transcript and the durable session log.
      const stdout = retainHeadBytes(result.stdout, cap, "stdout");
      const stderr = retainHeadBytes(result.stderr, cap, "stderr");
      if (stdout.length > 0) out += stdout;
      if (stderr.length > 0) {
        if (out.length > 0) out += "\n";
        out += stderr;
      }
      if (ctx.execWorld.target.kind === "peer") {
        out += `\n[exec-world: peer://${ctx.execWorld.target.peerId}]`;
      }
      const exit = result.exitCode ?? (result.timedOut ? 124 : 1);
      if (exit !== 0) {
        return {
          content: out || `bash exited ${exit}`,
          isError: true,
        };
      }
      return { content: out || "(no output)" };
    } catch (err) {
      return {
        content: `bash exec-world error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  if (ctx.sandboxExecutor !== undefined) {
    return runBashViaExecutor(command, ctx, timeout, cap, preWarning);
  }

  return new Promise((resolve) => {
    // `detached` on POSIX: the shell leads its own process group so the
    // kill ladder can address `-pid` without touching the harness's own
    // group. See `reaper.ts` for why the group matters.
    const detached = process.platform !== "win32";
    const child = spawn("sh", ["-c", command], {
      cwd: ctx.cwd,
      env: ctx.shellEnv ?? process.env,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const identity = captureChildIdentity(child);
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killed = false;
    let settled = false;

    const settle = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const finish = (note?: string): void => {
      settle(
        formatBashResult({
          stdout,
          stderr,
          exitCode: killed ? 137 : child.exitCode,
          stdoutTruncated,
          stderrTruncated,
          killed,
          cap,
          preWarning,
          ...(note !== undefined ? { sandboxNote: note } : {}),
        }),
      );
    };

    const kill = (): void => {
      killed = true;
      // TERM → grace → KILL against the group, with a bounded wait for
      // the pipes. A backgrounded grandchild that inherited stdout would
      // otherwise keep `close` from ever firing and hang the turn.
      void reapChild(child, {
        processGroup: detached,
        ...(identity !== undefined ? { identity } : {}),
        onForceClose: () => {
          finish();
        },
      });
    };

    const timer = setTimeout(kill, timeout);

    const onAbort = (): void => {
      kill();
    };
    if (ctx.abortSignal.aborted) {
      onAbort();
    } else {
      ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString("utf8");
      if (ctx.onToolOutput !== undefined && chunk.length > 0) {
        ctx.onToolOutput(chunk);
      }
      if (stdout.length + chunk.length > cap) {
        stdoutTruncated = true;
        stdout += chunk.slice(0, Math.max(0, cap - stdout.length));
      } else {
        stdout += chunk;
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

    child.on("close", () => {
      // `code` may be null (signal death); `finish` derives a
      // conventional 137 for a killed child.
      finish();
    });

    child.on("error", (err) => {
      settle({
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
): Promise<ToolResult> {
  const executor = ctx.sandboxExecutor!;
  const policy =
    ctx.sandboxPolicy ??
    policyFromMode(ctx.session.metadata.permissionMode ?? "read-only", ctx.cwd);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = (): void => ac.abort();
  if (ctx.abortSignal.aborted) ac.abort();
  else ctx.abortSignal.addEventListener("abort", onAbort, { once: true });

  const runOnce = (
    runPolicy: SandboxPolicy,
  ): Promise<SandboxResult> =>
    executor.execute(command, {
      policy: runPolicy,
      cwd: ctx.cwd,
      signal: ac.signal,
      maxOutputBytes: cap,
      ...(ctx.onToolOutput !== undefined
        ? { onStdout: ctx.onToolOutput }
        : {}),
    });

  const project = (
    result: SandboxResult,
    runPolicy: SandboxPolicy,
  ): BashProjection => ({
    stdout: result.stdout.length > cap ? result.stdout.slice(0, cap) : result.stdout,
    stderr: result.stderr.length > cap ? result.stderr.slice(0, cap) : result.stderr,
    exitCode: result.exitCode,
    stdoutTruncated:
      result.stdout.length > cap || result.stdoutTruncated === true,
    stderrTruncated:
      result.stderr.length > cap || result.stderrTruncated === true,
    failure: classifySandboxFailure({
      backend: policyToViolationBackend(runPolicy.backend),
      exitCode: result.exitCode,
      signal: result.signal ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
  });

  try {
    const result = await runOnce(policy);
    const projected = project(result, policy);
    const failure = projected.failure;

    // A policy denial is the one failure the model cannot act on: it
    // cannot widen its own sandbox, and re-running identically fails
    // identically. Offer the human the decision, then retry EXACTLY once.
    //
    // The approval decision is not made here — `requestSandboxEscalation`
    // is the executor's method, so `approval: "never"`, the
    // `PermissionRequest` veto, and the widening computation all stay
    // outside the tool's reach. The only local check is whether a wider
    // policy exists at all, which is pure.
    const wider: SandboxPolicy | undefined = isSandboxDenial(failure)
      ? widenSandboxPolicy(policy, { cwd: ctx.cwd, deniedPath: failure.path })
      : undefined;

    if (
      isSandboxDenial(failure) &&
      wider !== undefined &&
      ctx.requestSandboxEscalation !== undefined
    ) {
      const decision = await ctx.requestSandboxEscalation({
        tool: "bash",
        subject: command,
        denial: failure,
        currentPolicy: policy,
        cwd: ctx.cwd,
      });
      if (decision.kind === "allow") {
        const retried = project(await runOnce(decision.policy), decision.policy);
        return formatBashResult({
          ...retried,
          killed: ac.signal.aborted,
          cap,
          preWarning,
          meta: {
            ...(failure !== undefined ? { sandbox: failure } : {}),
            escalation: "granted",
            escalatedPolicy: decision.policy,
          },
          escalationNote:
            `[sandbox] escalation GRANTED (${decision.note}). The command was ` +
            "re-run with the wider policy; the output above is from that run.",
        });
      }
      return formatBashResult({
        ...projected,
        killed: ac.signal.aborted,
        cap,
        preWarning,
        meta: {
          ...(failure !== undefined ? { sandbox: failure } : {}),
          escalation: "denied",
        },
        escalationNote:
          `Escalation was NOT granted (${decision.reason}); the sandbox was ` +
          "not widened and the denial above stands.",
      });
    }

    return formatBashResult({
      ...projected,
      killed: ac.signal.aborted,
      cap,
      preWarning,
      ...(failure !== undefined
        ? {
            meta: {
              sandbox: failure,
              ...(isSandboxDenial(failure) &&
              ctx.requestSandboxEscalation !== undefined
                ? { escalation: "unavailable" as const }
                : {}),
            },
          }
        : {}),
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

/** A sandbox result projected into the shape `formatBashResult` consumes. */
interface BashProjection {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  failure: SandboxFailure | undefined;
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
  /**
   * Model-facing classification of a sandbox denial / infra failure.
   * Derived from `meta.sandbox` when the caller does not pass one, so a
   * denial can never be labelled in prose but missing from the structured
   * metadata (or vice versa).
   */
  sandboxNote?: string;
  /** Model-facing note about an escalation attempt. */
  escalationNote?: string;
  /** Structured metadata handed back to the executor and the trace. */
  meta?: ToolResultMeta;
}): ToolResult {
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
  const note = opts.sandboxNote ?? formatSandboxFailure(opts.meta?.sandbox);
  if (note !== undefined) parts.push(`\n${note}`);
  if (opts.escalationNote !== undefined) parts.push(`\n${opts.escalationNote}`);
  return {
    content: parts.join(""),
    isError: opts.exitCode !== 0,
    ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
  };
}
