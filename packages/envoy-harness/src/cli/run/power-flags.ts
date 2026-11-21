/**
 * Map CLI power-feature flags onto Agent constructor options.
 * Shared by one-shot, REPL, and ACP so argv ↔ Agent stays one place.
 */

import type { Agent } from "../../agent.js";
import type { RunParsedArgs } from "../argv-types.js";

export type AgentCtorOptions = ConstructorParameters<typeof Agent>[0];

export type PowerFeatureArgs = Pick<
  RunParsedArgs,
  "runCode" | "codeMode" | "toolSearch" | "schedule" | "goals" | "present" | "power"
>;

/**
 * Apply Wave1–4 opt-in features from parsed run argv.
 * When `defaults.scheduleGoalsPresent` is true (REPL/ACP), schedule /
 * goals / present turn on unless the user passed `--no-schedule` etc.
 */
export function applyPowerFeatureFlags(
  agentOptions: AgentCtorOptions,
  parsed: PowerFeatureArgs,
  defaults?: { scheduleGoalsPresent?: boolean },
): void {
  const power = parsed.power === true;
  const sgpDefault = defaults?.scheduleGoalsPresent === true;

  if (power || parsed.runCode) agentOptions.enableRunCode = true;
  if (power || parsed.codeMode) agentOptions.enableCodeMode = true;
  if (power || parsed.toolSearch) agentOptions.enableToolSearch = true;

  if (power || parsed.schedule || (sgpDefault && parsed.schedule !== false)) {
    agentOptions.enableSchedule = true;
  }
  if (power || parsed.goals || (sgpDefault && parsed.goals !== false)) {
    agentOptions.enableGoals = true;
  }
  if (power || parsed.present || (sgpDefault && parsed.present !== false)) {
    agentOptions.enablePresent = true;
  }
}
