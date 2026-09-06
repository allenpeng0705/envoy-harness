/**
 * R4.7 / R4.14 — re-export the unified ACP `team/jobs` board from Package 1.
 */

export {
  TeamJobRegistry,
  chainSubtasksToTeamJobs,
  hostLabel,
  mergeTeamJobBoards,
  type ChainSubtaskJobView,
  type StartPeerSubmitJobInput,
  type StartTeamJobInput,
} from "@envoymesh/envoy-harness";
