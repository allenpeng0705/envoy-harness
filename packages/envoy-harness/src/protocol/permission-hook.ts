/**
 * PreToolUse hook that forces host approval via AskHandler.
 *
 * ACP / embedding hosts set `AgentOptions.askHandler` to bridge
 * into `session/request_permission`. Without a PreToolUse `ask`
 * decision, that handler never runs — tools would execute silently.
 */

import type { HookRegistry } from "../hooks/index.js";
import type { HookDecision, HookEvent } from "../types.js";

export interface ToolPermissionAskHookOptions {
  /**
   * Return false to skip asking (auto-allow). Default: ask for every tool.
   */
  shouldAsk?: (toolName: string) => boolean;
}

/**
 * Register a PreToolUse handler that returns `{ kind: "ask" }` so
 * the agent loop pauses on `askHandler`. Returns an unregister fn.
 *
 * **Why this looks the way it does:** the `HookRegistry` invokes
 * handlers with a `HookEvent` (`{ name, payload }`), NOT with the
 * raw payload. An earlier version of this function accepted the
 * raw `payload: unknown` and tried to read `payload.tool` directly,
 * which was always undefined (the real field is `event.payload.tool`).
 * The bug was silent (the question defaulted to "Allow tool `tool`?")
 * and only caught by code review.
 */
export function installToolPermissionAskHook(
  hooks: HookRegistry,
  options?: ToolPermissionAskHookOptions,
): () => void {
  const shouldAsk = options?.shouldAsk ?? (() => true);
  const handler = async (event: HookEvent): Promise<HookDecision> => {
    const payload = event.payload;
    const tool =
      typeof payload === "object" &&
      payload !== null &&
      "tool" in payload &&
      typeof (payload as { tool: unknown }).tool === "string"
        ? (payload as { tool: string }).tool
        : "tool";
    if (!shouldAsk(tool)) {
      return { kind: "continue" };
    }
    return {
      kind: "ask",
      question: `Allow tool \`${tool}\`?`,
    };
  };
  hooks.on("PreToolUse", handler);
  return () => {
    hooks.unregister("PreToolUse", handler);
  };
}
