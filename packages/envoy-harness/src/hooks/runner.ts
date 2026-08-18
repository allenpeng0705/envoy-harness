/**
 * Hook runners — execute a single hook handler.
 *
 * **Two runners** (per design §8.3):
 *
 * - `runShellHandler` — spawn a shell, run a command, parse the
 *   output into a `HookDecision`. Used for the `handler.command`
 *   case.
 *
 * - `runModuleHandler` — `import()` a TS module, call its default
 *   export. Used for the `handler.module` case.
 *
 * **Wire format for shell handlers:**
 *
 * The shell handler receives the event payload via env vars:
 * - `HOOK_EVENT` — the event name (string)
 * - `HOOK_PAYLOAD` — the event payload (JSON string)
 * - `TOOL_CALL` — legacy alias for `HOOK_PAYLOAD` (deprecated)
 * - `RESULT_FILE` — populated by PostToolUse (not used in v0)
 *
 * The handler's stdout is parsed as JSON if possible:
 *   { "decision": "block", "reason": "..." }
 *   { "decision": "add-context", "content": "..." }
 *   { "decision": "continue" }  (or any other value)
 *
 * If stdout is not valid JSON, it's treated as `add-context` content
 * (after trimming). This is the "easy mode" — just `echo` something
 * and it's added to the context.
 *
 * **Non-zero exit** is treated as `block` with the first 200 chars
 * of stderr as the reason. This matches Codex's behavior.
 *
 * **Timeout** (default 5s) uses `SIGKILL` because a hung shell can't
 * be politely asked to exit. The decision is `block` with a
 * `timed out after Xms` reason.
 *
 * **Security:** hooks run with the same permission system as the
 * bash tool. A hook that does `rm -rf /` is caught by
 * `readOnlyValidation` if the session is in read-only mode. Hooks
 * are not a back door; they are part of the same trust model.
 */

import { spawn } from "node:child_process";

import type { HookDecision, HookEventName } from "../types.js";

/** Default timeout for shell handlers, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Maximum stderr length to include in the block reason. */
const MAX_STDERR_REASON = 200;

/**
 * Run a shell handler. The command runs in `sh -c "$command"`, with
 * the event payload passed via env vars. See file header for the
 * wire format.
 *
 * **Timeout:** if the handler doesn't complete within `timeoutMs`
 * (default 5s), it's killed with `SIGKILL` and the decision is
 * `block` with a `timed out` reason.
 *
 * **Idempotency:** running the same handler twice with the same
 * input returns the same decision (modulo non-determinism in the
 * command itself, which is the user's responsibility).
 */
export async function runShellHandler(
  command: string,
  eventName: HookEventName,
  payload: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HookDecision> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      env: {
        ...process.env,
        HOOK_EVENT: eventName,
        HOOK_PAYLOAD: JSON.stringify(payload),
        TOOL_CALL: JSON.stringify(payload), // legacy alias
        RESULT_FILE: "", // populated by PostToolUse (not used in v0)
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
    }

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          kind: "block",
          reason: `hook timed out after ${timeoutMs}ms`,
        });
        return;
      }

      if (code !== 0) {
        const reason = stderr.slice(0, MAX_STDERR_REASON);
        resolve({
          kind: "block",
          reason: `hook exited ${code}${reason ? `: ${reason}` : ""}`,
        });
        return;
      }

      // Parse stdout. JSON shape takes precedence; fall back to
      // plain text as add-context.
      const parsed = tryParseJson(stdout);
      if (parsed) {
        if (parsed.decision === "block") {
          resolve({
            kind: "block",
            reason: parsed.reason ?? "blocked by hook",
          });
        } else if (parsed.decision === "add-context") {
          resolve({ kind: "add-context", content: parsed.content ?? "" });
        } else if (parsed.decision === "modify") {
          // Modify is only meaningful for PostToolUse. The caller
          // (registry) handles the event-name check; here we just
          // pass it through.
          resolve({ kind: "modify", modified: parsed.modified });
        } else {
          resolve({ kind: "continue" });
        }
        return;
      }

      // Non-JSON stdout: treat as add-context (if non-empty).
      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        resolve({ kind: "add-context", content: trimmed });
      } else {
        resolve({ kind: "continue" });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        kind: "block",
        reason: `hook failed to start: ${err.message}`,
      });
    });
  });
}

/**
 * Run a module handler. Imports the module, calls its default
 * export with `{ name: eventName, payload }` (the `HookEvent` shape).
 * The default export must be a `HookFn` (see `types.js`).
 *
 * **Why dynamic import?** the module path is user-provided
 * (from `hooks.toml`). Static imports are resolved at compile
 * time and would not allow user-provided paths.
 */
export async function runModuleHandler(
  modulePath: string,
  eventName: HookEventName,
  payload: unknown,
): Promise<HookDecision> {
  try {
    const mod = await import(modulePath);
    if (typeof mod.default !== "function") {
      return {
        kind: "block",
        reason: `hook module ${modulePath} has no default export`,
      };
    }
    return await mod.default({ name: eventName, payload });
  } catch (err) {
    return {
      kind: "block",
      reason: `hook module ${modulePath} failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Try to parse stdout as JSON. Returns the parsed object, or
 * `null` if the stdout is not valid JSON. Used by the shell
 * runner to interpret the handler's decision.
 */
function tryParseJson(stdout: string): null | {
  decision?: string;
  reason?: string;
  content?: string;
  modified?: unknown;
} {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) return parsed;
    return null;
  } catch {
    return null;
  }
}
