/**
 * PreToolUse hook that forces host approval via AskHandler.
 *
 * ACP / embedding hosts set `AgentOptions.askHandler` to bridge
 * into `session/request_permission`. Without a PreToolUse `ask`
 * decision, that handler never runs — tools would execute silently.
 */

import type { HookRegistry } from "../hooks/index.js";
import type { HookDecision } from "../types.js";

export interface ToolPermissionAskHookOptions {
  /**
   * Return false to skip asking (auto-allow). Default: ask for every tool.
   */
  shouldAsk?: (toolName: string) => boolean;
}

/**
 * Register a PreToolUse handler that returns `{ kind: "ask" }` so
 * the agent loop pauses on `askHandler`. Returns an unregister fn.
 */
export function installToolPermissionAskHook(
  hooks: HookRegistry,
  options?: ToolPermissionAskHookOptions,
): () => void {
  const shouldAsk = options?.shouldAsk ?? (() => true);
  const handler = async (payload: unknown): Promise<HookDecision> => {
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
