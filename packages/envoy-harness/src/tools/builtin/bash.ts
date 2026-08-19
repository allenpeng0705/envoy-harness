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
 */

import { spawn } from "node:child_process";

import { z } from "zod";

import { validateBash } from "../../permissions/bash/index.js";
import { tokenizeShellCommand } from "../../permissions/bash/tokenize.js";
import { policyFromMode } from "../../permissions/policy.js";
import type { BashValidationInput, SandboxPolicy } from "../../types.js";
import type { Tool } from "../types.js";

/** Default timeout for a bash command, in milliseconds. */
const DEFAULT_BASH_TIMEOUT_MS = 30_000;

/** Maximum bytes captured per stream (stdout/stderr). */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

/**
 * A bash invocation. The model passes the raw command string;
 * the tool validates, then runs.
 *
 * **Why a `command` field instead of structured args (argv):**
 * the model thinks in shell, not in argv. Encoding "find files
 * modified in the last hour" as a JSON argv would be lossy.
 * The cost is a permission model that has to parse shell. We
 * pay that cost in `validateBash` and accept it.
 */
export const bashTool: Tool<
  z.ZodObject<{
    command: z.ZodString;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    maxOutputBytes: z.ZodOptional<z.ZodNumber>;
  }>
> = {
  name: "bash",
  description:
    "Run a shell command and return its stdout, stderr, and exit code. " +
    "The command is validated against the session's permission mode " +
    "(read-only / workspace-write / danger-full-access). Blocked " +
    "commands return isError: true without running. Use `timeoutMs` " +
    "(default 30000) and `maxOutputBytes` (default 1 MB) to cap " +
    "very long-running or verbose commands.",
  parameters: z.object({
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
  }),
  async execute({ command, timeoutMs, maxOutputBytes }, ctx) {
    const mode = ctx.session.metadata.permissionMode ?? "read-only";
    // Prefer the agent's live policy (so `/sandbox` and plan-mode
    // changes take effect); fall back to deriving from the session
    // for direct tool callers that don't pass one.
    const policy: SandboxPolicy = ctx.sandboxPolicy ?? policyFromMode(mode, ctx.cwd);

    // 1. Validate against the permission policy.
    const input: BashValidationInput = {
      command,
      // Tokenize the command so `pathValidation` can see the
      // actual operands (v0 passed `[]`, which made path
      // validation a no-op).
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
    if (verdict.kind === "allow-with-warning") {
      // Surface the warning but proceed. The model can decide
      // whether to retry with a safer command.
      return runBash(command, ctx, timeoutMs, maxOutputBytes, verdict.warning);
    }

    // 2. allow — run it.
    return runBash(command, ctx, timeoutMs, maxOutputBytes, undefined);
  },
};

/** Convert `process.env` to a `Record<string, string>` (filtering undefined). */
function envRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Spawn `sh -c <command>` and collect stdout/stderr/exitCode.
 * Honors both the per-tool timeout and the agent's abort signal.
 *
 * @param preWarning - if set, prefixed to the result so the model
 *   sees the warning. Comes from `validateBash`'s warn verdict.
 */
async function runBash(
  command: string,
  ctx: { cwd: string; abortSignal: AbortSignal },
  timeoutMs: number | undefined,
  maxOutputBytes: number | undefined,
  preWarning: string | undefined,
): Promise<{ content: string; isError?: boolean }> {
  const timeout = timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const cap = maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
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

    // If the user cancels the whole agent, kill the bash too.
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
      const parts: string[] = [];
      if (preWarning) parts.push(`[warning] ${preWarning}\n`);
      if (stdout.length > 0) {
        parts.push(stdout);
        if (stdoutTruncated) parts.push(`\n[stdout truncated at ${cap} bytes]`);
      }
      if (stderr.length > 0) {
        parts.push(`\n[stderr]\n${stderr}`);
        if (stderrTruncated) parts.push(`\n[stderr truncated at ${cap} bytes]`);
      }
      parts.push(`\n[exit code: ${code ?? "null"}]`);
      if (killed) parts.push(`\n[command was killed]`);
      const content = parts.join("");
      // Non-zero exit is reported as an error so the model can
      // decide whether to retry. The bash tool itself succeeded
      // (the command ran); the failure is in the command's exit.
      const isError = code !== 0;
      resolve({ content, isError });
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
