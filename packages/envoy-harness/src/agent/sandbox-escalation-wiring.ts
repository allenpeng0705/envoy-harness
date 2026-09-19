/**
 * Executor-side wiring for the tool-call surfaces: the escalation decision
 * and the durable diagnostics that record it.
 *
 * **Why this is its own module.** `tool-executor.ts` sits at the
 * module-size ceiling, and this is a genuinely separate concern: the
 * executor decides *whether to run a tool and how to record it*, while this
 * decides *what a sandbox denial means and who may widen it*. Splitting
 * them also makes the security-relevant rule legible in one place:
 * **a tool may never widen its own sandbox.**
 *
 * The surfaces built here are handed to tools through `ToolContext`:
 *
 * - `buildToolContext(signal)` — the context a tool's `execute` receives,
 *   with `requestSandboxEscalation` bound to the decision logic below.
 * - `recordSandboxDiagnostics(iteration, toolName, meta)` — the durable,
 *   switchable record of a denial / escalation, written to the session
 *   header rather than the transcript (which the model reads and which
 *   must keep a stable prompt-cache prefix).
 */

import type { Session } from "../session.js";
import type { ToolContext, ToolResultMeta } from "../tools/types.js";
import type {
  AskForApproval,
  AskHandler,
  SandboxPolicy,
} from "../types.js";
import type { SandboxExecutor } from "../sandbox/types.js";
import type { ExecWorld } from "../exec-world/types.js";
import type { HookFirer } from "../hooks/lifecycle.js";
import {
  fireNotification,
  firePermissionRequest,
} from "../hooks/lifecycle.js";
import {
  describeSandboxEscalation,
  describeWidening,
  widenSandboxPolicy,
  type SandboxEscalationDecision,
  type SandboxEscalationHandler,
  type SandboxEscalationRequest,
} from "../sandbox/escalation.js";
import { isSandboxDenial } from "../sandbox/classify.js";

/** Live accessors the surfaces read at call time. */
export interface ToolCallSurfaceDeps {
  readonly session: Session;
  readonly cwd: string;
  readonly hooks: HookFirer | undefined;
  readonly abortSignal: AbortSignal;
  readonly getSandboxPolicy: () => SandboxPolicy;
  readonly getSandboxExecutor: () => SandboxExecutor | undefined;
  readonly getApproval: () => AskForApproval;
  readonly getAskHandler: () => AskHandler | undefined;
  readonly getShellEnv?: () => Record<string, string>;
  readonly recordUndo?: (entry: {
    path: string;
    previousContent: string | null;
  }) => void;
  readonly execWorld?: ExecWorld;
}

/** The escalation + diagnostics surfaces the tool-call path uses. */
export interface ToolCallSurfaces {
  requestSandboxEscalation: SandboxEscalationHandler;
  buildToolContext: (signal: AbortSignal) => ToolContext;
  recordSandboxDiagnostics: (
    iteration: number,
    toolName: string,
    meta: ToolResultMeta | undefined,
  ) => void;
}

export function createToolCallSurfaces(
  deps: ToolCallSurfaceDeps,
): ToolCallSurfaces {
  /**
   * Offer a sandbox denial to the user for a widened retry.
   *
   * **Why the executor owns this.** A tool must not be able to widen its
   * own sandbox — that would make the policy advisory. The tool reports
   * the denial through `ToolContext.requestSandboxEscalation` and this
   * owns the decision, in the same order as every other approval in the
   * harness:
   *
   * 1. `approval: "never"` denies without asking (fail closed).
   * 2. `PermissionRequest` hooks get to veto outright — a hook that knows
   *    an action is forbidden should not put the question to a human.
   * 3. `Notification` tells observers a decision is pending.
   * 4. The host's ask handler decides.
   * 5. The widening itself is computed here (never supplied by the tool),
   *    and is `undefined` at the top of the ladder — in which case the
   *    answer is a deny, not a silent no-op.
   */
  const requestSandboxEscalation: SandboxEscalationHandler = async (
    request: SandboxEscalationRequest,
  ): Promise<SandboxEscalationDecision> => {
    const question = describeSandboxEscalation(request);
    if (deps.getApproval() === "never") {
      return { kind: "deny", reason: "approval mode is 'never'" };
    }
    const permission = await firePermissionRequest(deps.hooks, {
      sessionId: deps.session.id,
      tool: request.tool,
      args: { command: request.subject, path: request.denial.path },
      question,
    });
    if (permission.blocked !== undefined) {
      return {
        kind: "deny",
        reason: `blocked by PermissionRequest: ${permission.blocked}`,
      };
    }
    await fireNotification(deps.hooks, {
      sessionId: deps.session.id,
      kind: "sandbox_escalation",
      message: question,
    });
    const askHandler = deps.getAskHandler();
    if (askHandler === undefined) {
      return { kind: "deny", reason: "no ask handler configured" };
    }
    const decision = await askHandler({
      tool: request.tool,
      args: { command: request.subject, path: request.denial.path },
      question,
      signal: deps.abortSignal,
    });
    if (deps.abortSignal.aborted) {
      return { kind: "deny", reason: "cancelled while awaiting escalation" };
    }
    if (decision.kind === "deny") {
      return { kind: "deny", reason: decision.reason };
    }
    const widened = widenSandboxPolicy(request.currentPolicy, {
      cwd: request.cwd,
      deniedPath: request.denial.path,
    });
    if (widened === undefined) {
      return { kind: "deny", reason: "no wider policy is available" };
    }
    return {
      kind: "allow",
      policy: widened,
      note: describeWidening(request.currentPolicy, widened, request.cwd),
    };
  };

  const buildToolContext = (signal: AbortSignal): ToolContext => {
    const sandboxExecutor = deps.getSandboxExecutor();
    return {
      cwd: deps.cwd,
      session: deps.session,
      abortSignal: signal,
      sandboxPolicy: deps.getSandboxPolicy(),
      requestSandboxEscalation,
      ...(deps.getShellEnv !== undefined
        ? { shellEnv: deps.getShellEnv() }
        : {}),
      ...(sandboxExecutor !== undefined ? { sandboxExecutor } : {}),
      ...(deps.recordUndo !== undefined ? { recordUndo: deps.recordUndo } : {}),
      ...(deps.execWorld !== undefined ? { execWorld: deps.execWorld } : {}),
    };
  };

  /**
   * Record a sandbox denial / escalation into the session's durable
   * diagnostic log.
   *
   * Diagnostics are fire-and-forget: `recordDiagnostic` is optional on
   * `Session` (test doubles omit it) and a missing capability must never
   * turn a recorded result into a failed call.
   */
  const recordSandboxDiagnostics = (
    iteration: number,
    toolName: string,
    meta: ToolResultMeta | undefined,
  ): void => {
    const sandbox = meta?.sandbox;
    // Deliberately NOT gated on `isError`: a denial that was escalated and
    // then SUCCEEDED still happened, and "was this session ever refused by
    // the sandbox?" is the question the log exists to answer.
    if (sandbox === undefined) return;
    const at = new Date().toISOString();
    // Only a *denial* carries a reason and a path; an infrastructure
    // failure (exit 125) means the sandbox never ran the command, so it is
    // recorded as neither a denial nor an escalation candidate.
    const denial = isSandboxDenial(sandbox) ? sandbox : undefined;
    if (denial !== undefined) {
      deps.session.recordDiagnostic?.({
        kind: "sandbox-denied",
        at,
        iteration,
        backend: denial.backend,
        reason: denial.reason,
        ...(denial.path !== undefined ? { path: denial.path } : {}),
        detail: `${toolName}: ${denial.reason}`,
      });
    }
    if (denial === undefined || meta?.escalation === undefined) return;
    deps.session.recordDiagnostic?.({
      kind:
        meta.escalation === "granted"
          ? "sandbox-escalated"
          : "sandbox-escalation-denied",
      at,
      iteration,
      backend: denial.backend,
      reason: denial.reason,
      detail:
        meta.escalation === "granted" && meta.escalatedPolicy !== undefined
          ? `${toolName}: retried with ${meta.escalatedPolicy.mode}`
          : `${toolName}: escalation ${meta.escalation}`,
    });
  };

  return { requestSandboxEscalation, buildToolContext, recordSandboxDiagnostics };
}
