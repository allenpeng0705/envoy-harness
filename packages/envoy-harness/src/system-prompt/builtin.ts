/**
 * Phase G — built-in system-prompt sections.
 */

import { discoverAgentsMd, type DiscoveryOptions } from "../agents-md/index.js";
import type { PromptSection } from "./types.js";

/**
 * The AGENTS.md section (order -100, deepseek's identity/context slot).
 * Wires the (previously disconnected) discovery pipeline into the prompt.
 */
export function agentsMdSection(
  cwd: string,
  options: Omit<DiscoveryOptions, "cwd"> = {},
): PromptSection {
  return {
    name: "agents-md",
    order: -100,
    text: async () => {
      // Best-effort: a failed discovery (missing root, permission error)
      // contributes nothing rather than crashing the run.
      try {
        const loaded = await discoverAgentsMd({ cwd, ...options });
        return loaded.assembled;
      } catch {
        return "";
      }
    },
  };
}

/** The plan-mode section (order -50, after project context). */
export function planModeSection(text: string): PromptSection {
  return { name: "plan-mode", order: -50, text };
}

/**
 * The terminal guidance section (order 100, deepseek's tool-guidance slot).
 * Text adapted from `@deepseek-ai/dsh-tool-terminal` (MIT) with envoy's
 * tool names.
 */
export function terminalGuidanceSection(): PromptSection {
  return {
    name: "terminal:guidance",
    order: 100,
    text:
      "Use a terminal session only when work needs persistent terminal " +
      "state or interactive stdin; prefer bash/read_file/write/edit for " +
      "bounded one-shot operations. Track every terminal session id and " +
      "close sessions that no longer matter. An inferred_idle or timeout " +
      "result does not prove the foreground command exited.",
  };
}
