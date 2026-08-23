/**
 * Codex `[[hook.<Event>]]` table parser → `HookHandlerSpec[]`.
 */

import type { HookHandlerSpec } from "../schema.js";
import type { HookEventName } from "../../types.js";

const CODEX_HOOK_EVENTS: ReadonlyArray<HookEventName> = [
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "Notification",
  "PermissionRequest",
];

/**
 * Parse codex/envoy `hook` nested tables:
 * `[[hook.PreToolUse]]` → `{ hook: { PreToolUse: [...] } }`.
 */
export function parseCodexHookTable(
  hookRoot: unknown,
): HookHandlerSpec[] {
  if (hookRoot === null || typeof hookRoot !== "object") {
    return [];
  }
  const root = hookRoot as Record<string, unknown>;
  const specs: HookHandlerSpec[] = [];

  for (const event of CODEX_HOOK_EVENTS) {
    const groups = root[event];
    if (!Array.isArray(groups)) continue;
    for (const rawGroup of groups) {
      if (rawGroup === null || typeof rawGroup !== "object") continue;
      const group = rawGroup as Record<string, unknown>;
      const command = group["command"];
      if (typeof command !== "string" || command.length === 0) {
        continue;
      }
      const spec: HookHandlerSpec = { event, command };
      const match = group["match"];
      if (match !== null && typeof match === "object") {
        const m = match as Record<string, unknown>;
        if (typeof m.tool === "string" && m.tool.length > 0) {
          spec.match =
            m.tool === "*" ? {} : { tool: m.tool };
        }
      }
      if (typeof group.timeout === "number" && group.timeout > 0) {
        spec.timeoutMs = group.timeout * 1000;
      }
      specs.push(spec);
    }
  }

  return specs;
}
