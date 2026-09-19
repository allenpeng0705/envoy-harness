/**
 * One registry for the REPL and for ACP.
 *
 * Custom commands register first. Built-ins register last so they
 * win on a name collision — the same order `runRepl` has always used.
 */

import { BUILTIN_COMMANDS } from "./commands.js";
import { BUILTIN_INFO_COMMANDS } from "./commands-info.js";
import { BUILTIN_TIER2_BATCH2_COMMANDS } from "./commands-tier2-batch2.js";
import { BUILTIN_TIER2_BATCH3_COMMANDS } from "./commands-tier2-batch3.js";
import { BUILTIN_TIER2_BATCH4_COMMANDS } from "./commands-tier2-batch4.js";
import { BUILTIN_TIER2_COMMANDS } from "./commands-tier2.js";
import { ReplCommandRegistry } from "./registry.js";
import type { ReplCommand } from "./types.js";

export function buildBuiltinRegistry(
  customCommands?: ReadonlyArray<ReplCommand>,
): ReplCommandRegistry {
  const registry = new ReplCommandRegistry();
  if (customCommands !== undefined) {
    registry.registerAll(customCommands);
  }
  registry.registerAll(BUILTIN_COMMANDS);
  registry.registerAll(BUILTIN_INFO_COMMANDS);
  registry.registerAll(BUILTIN_TIER2_COMMANDS);
  registry.registerAll(BUILTIN_TIER2_BATCH2_COMMANDS);
  registry.registerAll(BUILTIN_TIER2_BATCH3_COMMANDS);
  registry.registerAll(BUILTIN_TIER2_BATCH4_COMMANDS);
  return registry;
}
