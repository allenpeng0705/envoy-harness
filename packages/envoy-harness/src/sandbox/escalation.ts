/**
 * Sandbox escalation — turning a denial into a decision the user can make.
 *
 * **The gap this closes.** `classify.ts` tells the model *why* a command
 * was refused, but the model cannot act on it: it cannot widen its own
 * sandbox, and re-running the identical command fails identically. So the
 * model's only options were to give up or to guess at a different
 * approach. A human sitting in front of the terminal could have simply
 * approved the write. This module is the missing rung: on a policy denial
 * the harness offers **one** escalated retry, then records what happened.
 *
 * **Why widen by directory, not by mode.** The blunt instrument is to jump
 * from `read-only` to `danger-full-access`. That is the wrong default: the
 * sandbox blocked a write to one path, and the user's intent is almost
 * always "let it write *there*". So the ladder grants the denied path's
 * parent directory first and only falls through to full access when there
 * is no usable path to grant or the grant would be a no-op. Granting `/`
 * is never produced by inference — it only ever arrives as an explicit
 * `danger-full-access`, which the prompt names out loud.
 *
 * **Fail-closed.** `approval: "never"` can never escalate, and a host with
 * no ask handler is a deny, matching the rest of the approval surface.
 */

import * as path from "node:path";

import type { AskForApproval, SandboxPolicy } from "../types.js";
import type { SandboxDenial } from "./classify.js";

export interface SandboxEscalationRequest {
  /** The tool that was refused (e.g. `bash`). */
  readonly tool: string;
  /** What it was acting on — the command line, when there is one. */
  readonly subject?: string;
  /** The classified denial that triggered the offer. */
  readonly denial: SandboxDenial;
  /** The policy in force when the operation was refused. */
  readonly currentPolicy: SandboxPolicy;
  readonly cwd: string;
}

export type SandboxEscalationDecision =
  | {
      readonly kind: "allow";
      /** The widened policy the retry must use. */
      readonly policy: SandboxPolicy;
      /** One line naming what changed, for the transcript. */
      readonly note: string;
    }
  | { readonly kind: "deny"; readonly reason: string };

/** Host-supplied escalation handler (the executor wires this). */
export type SandboxEscalationHandler = (
  request: SandboxEscalationRequest,
) => Promise<SandboxEscalationDecision>;

/**
 * The narrowest grant that could unblock a denied path.
 *
 * Returns `undefined` when no usable directory can be inferred — a bare
 * message, a path at the filesystem root, or a non-path token. The caller
 * then falls through to the mode bump rather than fabricating a grant.
 */
export function writableRootFor(
  deniedPath: string | undefined,
  cwd: string,
): string | undefined {
  if (deniedPath === undefined || deniedPath.length === 0) return undefined;
  if (!path.isAbsolute(deniedPath) && !deniedPath.startsWith("./") && !deniedPath.startsWith("../")) {
    return undefined;
  }
  const absolute = path.resolve(cwd, deniedPath);
  const parent = path.dirname(absolute);
  // `dirname("/x") === "/"`: granting `/` would silently be full filesystem
  // access. Never inferred — that decision belongs to `danger-full-access`.
  if (parent === path.parse(parent).root) return undefined;
  return parent;
}

/** True when `candidate` is already inside (or equal to) one of `roots`. */
export function rootsCover(
  roots: ReadonlyArray<string>,
  candidate: string,
  cwd: string,
): boolean {
  const target = path.resolve(cwd, candidate);
  for (const root of roots) {
    const resolved = path.resolve(cwd, root);
    const rel = path.relative(resolved, target);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

/**
 * One rung up the escalation ladder, or `undefined` at the top.
 *
 * - `read-only` → `workspace-write`, writable root = the denied directory
 *   (or `cwd` when no path was named).
 * - `workspace-write` → the denied directory added to `writableRoots`; if
 *   that would change nothing, `danger-full-access`.
 * - `danger-full-access` → `undefined` (nothing is wider).
 *
 * The returned policy keeps `backend` and `slashTmpWritable` as they were:
 * escalation widens *what the policy allows*, it does not tear down the
 * kernel layer that enforces it.
 */
export function widenSandboxPolicy(
  policy: SandboxPolicy,
  options: { cwd: string; deniedPath?: string | undefined },
): SandboxPolicy | undefined {
  if (policy.mode === "danger-full-access") return undefined;

  const deniedRoot = writableRootFor(options.deniedPath, options.cwd);

  if (policy.mode === "read-only") {
    return {
      ...policy,
      mode: "workspace-write",
      writableRoots: deniedRoot !== undefined ? [deniedRoot] : [options.cwd],
    };
  }

  // workspace-write: prefer the surgical grant.
  if (deniedRoot !== undefined && !rootsCover(policy.writableRoots, deniedRoot, options.cwd)) {
    return {
      ...policy,
      writableRoots: [...policy.writableRoots, deniedRoot],
    };
  }
  return { ...policy, mode: "danger-full-access", writableRoots: [] };
}

/**
 * Whether offering an escalation is even meaningful.
 *
 * Infrastructure failures are explicitly excluded: exit 125 means the
 * sandbox never started the command, so widening the policy cannot help
 * and prompting the user would be a lie.
 */
export function canEscalate(options: {
  policy: SandboxPolicy;
  denial: SandboxDenial;
  approval: AskForApproval;
  cwd: string;
}): boolean {
  if (options.approval === "never") return false;
  return (
    widenSandboxPolicy(options.policy, {
      cwd: options.cwd,
      deniedPath: options.denial.path,
    }) !== undefined
  );
}

/** One line naming what the widening changed. */
export function describeWidening(
  before: SandboxPolicy,
  after: SandboxPolicy,
  cwd: string,
): string {
  if (after.mode === before.mode) {
    const added = after.writableRoots.filter(
      (r) => !rootsCover(before.writableRoots, r, cwd),
    );
    return `${before.mode} (writable roots + ${added.join(", ")})`;
  }
  return `${before.mode} → ${after.mode}`;
}

/** The question put to the user (also used as the `Notification` message). */
export function describeSandboxEscalation(
  request: SandboxEscalationRequest,
): string {
  const where =
    request.denial.path !== undefined ? ` to \`${request.denial.path}\`` : "";
  const subject =
    request.subject !== undefined && request.subject.length > 0
      ? `\n\nCommand: ${request.subject}`
      : "";
  const wider = widenSandboxPolicy(request.currentPolicy, {
    cwd: request.cwd,
    deniedPath: request.denial.path,
  });
  const target =
    wider === undefined
      ? "no wider policy is available"
      : describeWidening(request.currentPolicy, wider, request.cwd);
  return (
    `The ${request.denial.backend} sandbox blocked a ` +
    `${request.denial.reason.replace(/_/g, " ")}${where}. ` +
    `Re-run it with a wider sandbox (${target})? ` +
    "This grants the tool more access than the session's current policy." +
    subject
  );
}

/** Machine-readable escalation outcome carried on the tool result. */
export type SandboxEscalationOutcome = "granted" | "denied" | "unavailable";
