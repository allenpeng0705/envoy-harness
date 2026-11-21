/**
 * Default ReplProfileLoader from a merged ConfigLayer `[profiles]` table.
 */

import type { ConfigLayer } from "../../config/schema.js";
import type { ReplProfile, ReplProfileLoader } from "../repl/types.js";

export function createConfigProfileLoader(
  layer: ConfigLayer,
): ReplProfileLoader {
  const map = new Map<string, ReplProfile>();
  const top = layer.profiles;
  if (top !== undefined) {
    for (const [name, value] of Object.entries(top)) {
      if (value !== null && typeof value === "object") {
        map.set(name, value as ReplProfile);
      }
    }
  }

  return {
    list: () => [...map.keys()].sort(),
    get: (name: string) => map.get(name) ?? null,
  };
}

/**
 * Apply named profile fields that map onto ConfigLayer overrides.
 * Startup `--profile` applies `sandbox` → `permissionMode` and
 * `approval` → `askForApproval`. `provider` / `model` stay as
 * profile metadata (use CLI `--provider`/`--model` or `/model`);
 * `/profile apply` prints a note for model the same way.
 */
export function profileAsOverrides(
  profile: ReplProfile | null | undefined,
): ConfigLayer {
  if (profile === undefined || profile === null) return {};
  const out: ConfigLayer = {};
  if (typeof profile.sandbox === "string") {
    out.permissionMode = profile.sandbox as ConfigLayer["permissionMode"];
  }
  if (typeof profile.approval === "string") {
    out.askForApproval = profile.approval as ConfigLayer["askForApproval"];
  }
  return out;
}
