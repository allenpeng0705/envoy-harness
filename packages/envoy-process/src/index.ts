/**
 * Shared process helpers — owned here so Package 1 and
 * `envoy-sandbox-win` stay in sync without a circular package edge.
 */

export { killProcessTree } from "./kill-tree.js";

export {
  DEFAULT_TERM_GRACE_MS,
  identityMatches,
  readProcessIdentity,
  terminateProcessTree,
  type KillTreeOptions,
  type ProcessIdentity,
} from "./terminate.js";

export {
  DEFAULT_REAP_GRACE_MS,
  DEFAULT_REAP_SETTLE_MS,
  captureChildIdentity,
  reapChild,
  type ReapChildOptions,
} from "./reap.js";
