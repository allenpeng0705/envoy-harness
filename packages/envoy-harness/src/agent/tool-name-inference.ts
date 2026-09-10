/**
 * Recover a tool name the model omitted.
 *
 * Extracted from `tool-executor.ts` (which must stay under the CI
 * module-size hard cap) and kept pure so it is directly unit-testable.
 */

import type { ToolRegistry } from "../tools/index.js";

/**
 * Recover a missing tool name by matching the args against the
 * registered tools' zod schemas. Returns the tool name only when EXACTLY
 * ONE tool validates — ambiguous matches stay unresolved (the caller
 * refuses the call) so we never guess wrong.
 */
export function inferToolNameFromArgs(
  tools: ToolRegistry,
  args: unknown,
): string | undefined {
  // Key-based fallback: an args object carrying a tool-specific key is
  // unambiguous even if a future tool's schema also accepts it. This is
  // the pragmatic recovery for providers that drop the tool name.
  if (args !== null && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.command === "string" && tools.has("bash")) {
      return "bash";
    }
    if (typeof record.path === "string" && tools.has("read_file")) {
      return "read_file";
    }
  }

  let match: string | undefined;
  let count = 0;
  for (const t of tools.list()) {
    const parsed = t.parameters.safeParse(args);
    // Require the schema to actually consume at least one argument key:
    // an all-optional schema (e.g. `suggest_follow_ups`) matches ANY
    // object after zod strips unknown keys, which would make inference
    // ambiguous for every call.
    const data = parsed.data as Record<string, unknown> | undefined;
    const consumedKeys =
      parsed.success &&
      data !== undefined &&
      typeof data === "object" &&
      Object.keys(data).length > 0;
    if (consumedKeys) {
      match = t.name;
      count += 1;
      if (count > 1) return undefined;
    }
  }
  return count === 1 ? match : undefined;
}
