/**
 * R4.6 — collaboration modes (Plan / Default / Review).
 *
 * Orthogonal to {@link PlanState} (document lifecycle). `ModeKind`
 * controls tool policy + prompt guidance for the current turn.
 */

export type ModeKind = "default" | "plan" | "review";

export interface CollaborationModeState {
  kind: ModeKind;
  updatedAt: string;
  /** Sandbox mode to restore when leaving plan/review (Agent-owned). */
  previousPermissionMode?: "read-only" | "workspace-write" | "danger-full-access";
}

export function createCollaborationModeState(
  kind: ModeKind = "default",
): CollaborationModeState {
  return { kind, updatedAt: new Date().toISOString() };
}

/** Short system/ephemeral guidance injected when mode ≠ default. */
export function collaborationModePrompt(kind: ModeKind): string | undefined {
  switch (kind) {
    case "plan":
      return (
        "COLLABORATION MODE: PLAN\n" +
        "Investigate and draft a plan only. Do not modify the workspace " +
        "(no write/edit/task/jobs/terminals) until the user approves and " +
        "you leave plan mode. Prefer read_file, git, and ask_user."
      );
    case "review":
      return (
        "COLLABORATION MODE: REVIEW\n" +
        "Verify and inspect only. Read files, run read-only checks, and " +
        "report findings. Do not modify the workspace."
      );
    default:
      return undefined;
  }
}
