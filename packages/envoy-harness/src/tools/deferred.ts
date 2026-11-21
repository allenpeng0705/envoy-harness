/**
 * Wave 1 — deferred tool exposure (Codex tool_search companion).
 *
 * Tools marked `exposure: "deferred"` are omitted from the model-facing
 * catalog until granted for the turn/session via `tool_search` (or
 * code_mode grantNamespaces).
 */

import type { Tool } from "./types.js";

export type ToolExposure = "always" | "deferred";

export type ToolWithExposure = Tool & {
  exposure?: ToolExposure;
};

export function getToolExposure(tool: Tool): ToolExposure {
  return (tool as ToolWithExposure).exposure ?? "always";
}

export function withExposure<T extends Tool>(
  tool: T,
  exposure: ToolExposure,
): T & { exposure: ToolExposure } {
  return Object.assign(tool, { exposure });
}

/** Session/turn grant set for deferred tools. */
export interface DeferredGrantStore {
  grant(names: ReadonlyArray<string>): string[];
  has(name: string): boolean;
  list(): string[];
  clear(): void;
}

export function createDeferredGrantStore(): DeferredGrantStore {
  const set = new Set<string>();
  return {
    grant(names) {
      const added: string[] = [];
      for (const n of names) {
        if (n.length === 0) continue;
        if (!set.has(n)) {
          set.add(n);
          added.push(n);
        }
      }
      return added;
    },
    has(name) {
      return set.has(name);
    },
    list() {
      return [...set].sort();
    },
    clear() {
      set.clear();
    },
  };
}

/**
 * Tools visible to the model: always-exposed + granted deferred + tool_search.
 */
export function listModelFacingTools(
  tools: ReadonlyArray<Tool>,
  grants: DeferredGrantStore,
): Tool[] {
  return tools.filter((t) => {
    if (t.name === "tool_search") return true;
    const exposure = getToolExposure(t);
    if (exposure === "always") return true;
    return grants.has(t.name);
  });
}
