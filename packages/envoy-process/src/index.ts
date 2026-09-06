/**
 * Shared process helpers — owned here so Package 1 and
 * `envoy-sandbox-win` stay in sync without a circular package edge.
 */

export { killProcessTree } from "./kill-tree.js";
