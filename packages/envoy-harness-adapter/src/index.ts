/**
 * @envoymesh/envoy-harness-adapter — the reference MAP adapter.
 *
 * **What this package is:** the bridge between envoy-harness
 * (Package 1, mesh-agnostic) and EnvoyMesh's mesh (Package 2
 * protocol + Package "agent-adapter" interface). Implements
 * `AgentAdapter` from `@envoymesh/agent-adapter`.
 *
 * **What this package is NOT:**
 * - Not a fork of envoy-harness. The adapter depends on the
 *   package; the package does NOT depend on the adapter.
 *   (One-way dependency: adapter → harness.)
 * - Not a generic EnvoyMesh library. The adapter is specific
 *   to envoy-harness as the runtime.
 *
 * **Design doc:** `docs/improving-agent-network.en.md` §5.2
 * (in the EnvoyMesh monorepo). Reference implementations:
 * `OpenClawAdapter`, `PiAdapter` in
 * `packages/agent-adapter/src/`.
 *
 * **Stability:** the public surface is `EnvoyHarnessAdapter`
 * (class), `ENVOY_HARNESS_SKILLS`, and the per-adapter
 * helpers. Additive; new fields don't break existing callers.
 */

// F8.0 scaffold — the actual adapter lands in F8.1+. This file
// exists so the package builds, installs, and exports a marker.
// The first real export is the package version.
export const ENVOY_HARNESS_ADAPTER_VERSION = "0.0.0" as const;

// F8.1 — skills catalog + tool mapping.
export {
  ENVOY_HARNESS_SKILLS,
  ENVOY_HARNESS_VERSION,
  getToolsForSkill,
  isReadOnlySkill,
  type EnvoyHarnessSkillId,
  type EnvoyHarnessToolName,
} from "./skills.js";
