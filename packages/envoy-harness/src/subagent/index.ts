/**
 * Sub-agent public API (F10.1, §10.3 of the design).
 *
 * **What this module exports:** the type surface +
 * the default no-op submitter. The `LocalMeshSubmitter`
 * + the `task` tool land in F10.1.2 and F10.1.3
 * (follow-up commits).
 *
 * **Exports:**
 * - Types: `SubagentInput`, `SubagentResult`,
 *   `MeshSubmitter`.
 * - `NoopMeshSubmitter` + `NOOP_MESH_SUBMITTER_ERROR`
 *   (the default-when-undefined submitter, used by
 *   tests + forward-compat).
 *
 * **Stability:** the public surface is the union of
 * the above. Additive; new fields on the input /
 * result types are additive.
 */

export type { SubagentInput, SubagentResult, MeshSubmitter } from "./types.js";

export {
  NoopMeshSubmitter,
  NOOP_MESH_SUBMITTER_ERROR,
} from "./noop-submitter.js";
