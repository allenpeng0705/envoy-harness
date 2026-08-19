/**
 * Config schema — the v0 subset of the design §20 TOML
 * config file. Not the full schema: just the fields the
 * loader actually reads today.
 *
 * **Why a zod schema, not a hand-rolled type?**
 * smol-toml returns a plain object with `unknown` values;
 * the zod schema validates the shape + value kinds at
 * load time, so the rest of the code can rely on the
 * narrower types without per-field guards.
 *
 * **Why not the full §20 schema?** The full design has
 * ~30 fields (MCP, mesh, self-evolve, hooks, etc.).
 * Most of them are aspirational (see §2.5 of the
 * implementation plan: "MCP — deferred", "OS sandbox —
 * deferred", etc.). T2.2 ships the subset that has a
 * consumer today: the permission + sandbox + writable-
 * roots fields that flow into `AgentOptions`. The rest
 * lands when their consumers do.
 *
 * **Field naming:** kebab-case in the file
 * (`permission_mode`), camelCase in the type
 * (`permissionMode`). The mapping is at the schema
 * level, so consumers never see the file convention.
 */
import { z } from "zod";

import {
  AskForApprovalSchema,
  PermissionModeSchema,
  SandboxBackendSchema,
} from "../types.js";

/**
 * The v0 user-config layer. All fields are optional —
 * a config file may set only some of them; the rest
 * fall back to the agent's defaults.
 *
 * **Why `.strict()`:** a typo in a TOML key
 * (`permision_mode`) would otherwise be silently
 * ignored (zod's default is "strip unknown"). With
 * `.strict()`, the loader surfaces it as a clear
 * `invalid config shape: permision_mode: unrecognized
 * key` error. Cheap to debug; cheap to add.
 */
export const ConfigLayerSchema = z
  .object({
    /** Mirrors `PermissionMode`. */
    permissionMode: PermissionModeSchema.optional(),
    /** Mirrors `AskForApproval`. */
    askForApproval: AskForApprovalSchema.optional(),
    /** Mirrors `SandboxBackend`. */
    sandboxBackend: SandboxBackendSchema.optional(),
    /** If true, network is allowed in workspace-write mode. */
    networkAccess: z.boolean().optional(),
    /**
     * If true, /tmp is treated as a writable root
     * (the renamed `excludeSlashTmp` — see T1.1).
     */
    slashTmpWritable: z.boolean().optional(),
    /** Extra paths writable in workspace-write mode. */
    writableRoots: z.array(z.string()).optional(),
  })
  .strict();
export type ConfigLayer = z.infer<typeof ConfigLayerSchema>;
