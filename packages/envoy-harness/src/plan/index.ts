/**
 * Phase A / Item 6 — public surface for the plan
 * subsystem. Re-exported by the package entry point.
 */

export {
  applyTransition,
  createPlanState,
  PlanTransitionError,
  type PlanReviewStatus,
  type PlanState,
  type PlanTransition,
} from "./state.js";

export {
  PLAN_FRAGMENT_PRIORITY,
  buildPlanFragment,
  renderPlanText,
} from "./inject.js";

export { runReview, type ReviewVerdict, type RunReviewOptions } from "./review.js";

export {
  makeEnterPlanModeTool,
  makeExitPlanModeTool,
} from "./mode-tools.js";

export {
  collaborationModePrompt,
  createCollaborationModeState,
  type CollaborationModeState,
  type ModeKind,
} from "./mode-kind.js";

export {
  MUTATING_TOOL_NAMES,
  REVIEW_ALLOW_TOOL_NAMES,
  collaborationModeBlockReason,
  filterToolNamesForMode,
  modeForcesReadOnly,
} from "./tool-policy.js";
