/**
 * Shell-kind facade: bash validators on POSIX, PowerShell on win32 pwsh.
 */

import type { BashValidationInput, BashVerdict } from "../types.js";
import { validateBash } from "./bash/index.js";
import { tokenizeShellCommand } from "./bash/tokenize.js";
import {
  makePowerShellValidationInput,
  validatePowerShell,
} from "./powershell/index.js";
import type { ShellInvocation } from "../tools/shell-invocation.js";

export type ShellKind = ShellInvocation["kind"];

export async function validateShellCommand(
  kind: ShellKind,
  input: Omit<BashValidationInput, "argv"> & { argv?: ReadonlyArray<string> },
): Promise<BashVerdict> {
  if (kind === "pwsh" || kind === "powershell") {
    return validatePowerShell(makePowerShellValidationInput(input));
  }
  const argv = input.argv ?? tokenizeShellCommand(input.command);
  return validateBash({ ...input, argv });
}
