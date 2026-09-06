/**
 * @envoymesh/envoy-harness — public API entry point.
 *
 * Phase 1: types only. The runtime lands in subsequent phases per
 * the design doc §22 (Migration and timeline).
 *
 * See `docs/design.md` for the full design.
 *
 * Re-exports are split across `index-api-core.ts` and
 * `index-api-ext.ts` to stay under the module-size hard cap.
 */

export const VERSION = "0.0.0" as const;

export * from "./index-api-core.js";
export type * from "./index-api-core.js";
export * from "./index-api-ext.js";
export type * from "./index-api-ext.js";
