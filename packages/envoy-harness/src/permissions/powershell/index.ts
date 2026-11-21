/**
 * PowerShell validator composition (Wave 3).
 * Mirrors bash short-circuit rules: block first, then warning.
 */

import type {
  BashValidationInput,
  BashValidator,
  BashVerdict,
} from "../../types.js";
import { powerShellDestructiveWarning } from "./destructive-warning.js";
import { powerShellModeValidation } from "./mode.js";
import { powerShellReadOnlyValidation } from "./read-only.js";
import { tokenizePowerShellCommand } from "./tokenize.js";

export {
  powerShellDestructiveWarning,
  powerShellModeValidation,
  powerShellReadOnlyValidation,
  tokenizePowerShellCommand,
};

export const POWERSHELL_VALIDATORS: ReadonlyArray<BashValidator> = [
  powerShellReadOnlyValidation,
  powerShellModeValidation,
  powerShellDestructiveWarning,
];

export async function validatePowerShell(
  input: BashValidationInput,
): Promise<BashVerdict> {
  for (const v of POWERSHELL_VALIDATORS) {
    const verdict = await v.validate(input);
    if (verdict.kind === "block") return verdict;
  }
  for (const v of POWERSHELL_VALIDATORS) {
    const verdict = await v.validate(input);
    if (verdict.kind === "allow-with-warning") return verdict;
  }
  return { kind: "allow" };
}

export function makePowerShellValidationInput(
  base: Omit<BashValidationInput, "argv"> & { argv?: ReadonlyArray<string> },
): BashValidationInput {
  return {
    ...base,
    argv: base.argv ?? tokenizePowerShellCommand(base.command),
  };
}
