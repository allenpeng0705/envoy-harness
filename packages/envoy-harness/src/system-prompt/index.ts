/**
 * Phase G — system-prompt assembly public surface.
 */

export {
  createSystemPromptRegistry,
  type SystemPromptRegistry,
} from "./registry.js";
export {
  agentsMdSection,
  planModeSection,
  terminalGuidanceSection,
} from "./builtin.js";
export { buildAgentSystemPrompt, type BuildAgentSystemPromptOptions } from "./wire.js";
export type { PromptAssemblyContext, PromptSection } from "./types.js";
