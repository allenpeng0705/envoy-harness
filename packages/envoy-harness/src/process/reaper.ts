/**
 * Re-export shared child-reaping helper for Package-1 callers.
 * Implementation lives in `@envoymesh/envoy-process`.
 */

export {
  DEFAULT_REAP_SETTLE_MS,
  captureChildIdentity,
  reapChild,
  type ReapChildOptions,
} from "@envoymesh/envoy-process";
