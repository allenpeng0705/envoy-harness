/**
 * Sub-agent public API (F10.1, §10.3 of the design).
 *
 * **What this module exports:** the type surface +
 * the default implementations (no-op + local) +
 * the default sub-agent factory. The `task` tool
 * lands in F10.1.3 (follow-up commit).
 *
 * **Exports:**
 * - Types: `SubagentInput`, `SubagentResult`,
 *   `MeshSubmitter`.
 * - `NoopMeshSubmitter` (default error) +
 *   `NOOP_MESH_SUBMITTER_ERROR` (the documented
 *   message).
 * - `LocalMeshSubmitter` (the "real workable"
 *   default) + `defaultBuildSubagentFactory` (the
 *   default factory for fresh local sessions).
 *
 * **Stability:** the public surface is the union of
 * the above. Additive; new fields on the input /
 * result types are additive; new submitter classes
 * are additive.
 */

export type { SubagentInput, SubagentResult, MeshSubmitter } from "./types.js";

export {
  NoopMeshSubmitter,
  NOOP_MESH_SUBMITTER_ERROR,
} from "./noop-submitter.js";

export {
  LocalMeshSubmitter,
  defaultBuildSubagentFactory,
  type DefaultBuildSubagentFactoryOptions,
  type LocalMeshSubmitterOptions,
} from "./local-mesh-submitter.js";
