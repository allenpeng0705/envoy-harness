/**
 * Phase G — build the Agent's system prompt for the CLI runners.
 *
 * Default composition:
 *   -100  agents-md      (AGENTS.md discovery — now actually wired)
 *    -50  plan-mode      (only when `--plan`)
 *    100  terminal:guidance
 *
 * Hosts can pass extra sections (e.g. persona at order 0). Future deepseek
 * prompt-section contributions reuse the same `{ name, order, text }`
 * shape — copy them in (MIT) or bridge them from a hosted plugin.
 */

import { createSystemPromptRegistry } from "./registry.js";
import { agentsMdSection, planModeSection, terminalGuidanceSection } from "./builtin.js";
import type { PromptSection } from "./types.js";

export interface BuildAgentSystemPromptOptions {
  cwd: string;
  plan?: boolean;
  /** Extra sections (e.g. persona at order 0). Registered after built-ins. */
  extraSections?: ReadonlyArray<PromptSection>;
  /** Include the terminal guidance section (default true). */
  terminalGuidance?: boolean;
}

/** Render the default envoy system prompt for a run. */
export async function buildAgentSystemPrompt(
  options: BuildAgentSystemPromptOptions,
): Promise<string> {
  const registry = createSystemPromptRegistry();
  registry.register(agentsMdSection(options.cwd));
  if (options.plan === true) {
    registry.register(
      planModeSection(
        "You are in PLAN MODE. Investigate and produce a plan only — " +
          "do not make any changes to the workspace. Your session is read-only.",
      ),
    );
  }
  if (options.terminalGuidance !== false) {
    registry.register(terminalGuidanceSection());
  }
  for (const section of options.extraSections ?? []) {
    registry.register(section);
  }
  return registry.render();
}
