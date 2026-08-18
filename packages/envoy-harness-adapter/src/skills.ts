/**
 * ENVOY_HARNESS_SKILLS — the catalog of skills this adapter
 * advertises on the mesh.
 *
 * **Design doc:** `docs/improving-agent-network.en.md` §5.2
 * (in the EnvoyMesh monorepo) + envoy-harness's own design
 * §11. The 5 skills map to envoy-harness's local tool
 * surface (read_file + bash).
 *
 * **Skill → tool mapping:** each skill is a thin wrapper
 * over a known tool composition. The adapter's
 * `EnvoyHarnessAdapter.execute()` reads `getToolsForSkill()`
 * to know which local tools to expose. The mapping is
 * **adapter-internal** — the wire format doesn't know
 * about local tools; only the adapter does.
 *
 * **Sensitivity:** `public` means "anyone on the mesh
 * can call this"; `friends` means "owners I'm bonded
 * with"; `private` means "only me". envoy-harness v0
 * defaults everything to `private` (the harness is the
 * home-team agent; we don't expose skills to the open
 * mesh). A future chunk can lift this when the user
 * explicitly opts in to a friend network.
 *
 * **Cost ceiling:** soft signal only. The orchestrator's
 * `chain-budget-ledger` is the authoritative gate.
 * envoy-harness's per-call cap (`--max-cost-usd`,
 * F7.5) is the second line of defense.
 *
 * **Stability:** the catalog is the public surface.
 * Adding new skills is additive; removing one is a
 * breaking change (it'd orphan in-flight tasks).
 */

import type { SkillDescriptor } from "@envoymesh/protocol";

/**
 * The set of skill IDs this adapter advertises. As a
 * literal union (not `string`) so `getToolsForSkill()`
 * and the verifier can exhaustively check.
 */
export type EnvoyHarnessSkillId =
  | "code-edit"
  | "code-review"
  | "doc-search"
  | "bash-run"
  | "plan";

/** The full catalog. The orchestrator reads this for the manifest. */
export const ENVOY_HARNESS_SKILLS: ReadonlyArray<SkillDescriptor> = [
  {
    skillId: "code-edit",
    description:
      "Read, edit, and write code in a project. Uses read_file + bash.",
    costCeilingUsd: 5.0,
    maxSensitivity: "private",
    tags: ["code", "edit"],
  },
  {
    skillId: "code-review",
    description:
      "Review a diff for correctness and style. Read-only by default.",
    costCeilingUsd: 3.0,
    maxSensitivity: "private",
    tags: ["code", "review"],
  },
  {
    skillId: "doc-search",
    description:
      "Search docs and notes for a query. Read-only.",
    costCeilingUsd: 1.0,
    maxSensitivity: "private",
    tags: ["doc", "search"],
  },
  {
    skillId: "bash-run",
    description:
      "Run a constrained bash command on the worker. Bounded scope.",
    costCeilingUsd: 0.5,
    maxSensitivity: "private",
    tags: ["bash", "shell"],
  },
  {
    skillId: "plan",
    description:
      "Read-only planning and exploration. No writes, no network.",
    costCeilingUsd: 1.0,
    maxSensitivity: "private",
    tags: ["plan"],
  },
];

/** The set of well-known envoy-harness tool names. v0 ships two. */
export type EnvoyHarnessToolName = "read_file" | "bash";

/**
 * Map a skill ID to the local tools the executor should
 * expose. v0's envoy-harness ships two tools: `read_file`
 * and `bash`. The mapping is the *adapter's* decision —
 * the wire format only knows about skill IDs, not tools.
 *
 * **Read-only skills** (`code-review`, `doc-search`, `plan`)
 * expose only `read_file`. **Read+write skills**
 * (`code-edit`) expose both. **Exec-only** (`bash-run`)
 * exposes only `bash`.
 *
 * **Adding a new tool:** extend the `EnvoyHarnessToolName`
 * union and update the map. The verifier + executor
 * catch mismatches at the boundary.
 */
export function getToolsForSkill(skillId: string): ReadonlyArray<EnvoyHarnessToolName> {
  switch (skillId) {
    case "code-edit":
      return ["read_file", "bash"];
    case "code-review":
      return ["read_file"];
    case "doc-search":
      return ["read_file"];
    case "bash-run":
      return ["bash"];
    case "plan":
      return ["read_file"];
    default:
      // Unknown skill ID: refuse the surface. The orchestrator
      // would not send this (it reads the manifest), so the
      // empty array is defensive. The executor must surface
      // this as an error so the task is not silently executed
      // with no tools.
      return [];
  }
}

/** True if the skill is read-only (no bash, no writes). */
export function isReadOnlySkill(skillId: string): boolean {
  const tools = getToolsForSkill(skillId);
  return tools.length === 0 || (tools.length === 1 && tools[0] === "read_file");
}

/** The version of the envoy-harness runtime. Surfaced in the manifest. */
export const ENVOY_HARNESS_VERSION = "0.0.0" as const;
