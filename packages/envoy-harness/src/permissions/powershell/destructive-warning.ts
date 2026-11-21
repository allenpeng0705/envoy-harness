/**
 * PowerShell destructive-command warning heuristic.
 */

import type { BashValidationInput, BashValidator, BashVerdict } from "../../types.js";

const DESTRUCTIVE_PATTERN =
  /Remove-Item\s+[^\n]*(-Recurse|-r)\b|Format-Volume\b|Clear-Disk\b|Reset-ComputerMachinePassword\b|Remove-Item\s+[^\n]*\\:\s*$|rm\s+(-[a-z]*r[a-z]*\s+)?\/(\s|$)/i;

export const powerShellDestructiveWarning: BashValidator = {
  name: "powershell-destructive-warning",
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (DESTRUCTIVE_PATTERN.test(input.command)) {
      return {
        kind: "allow-with-warning",
        warning: "destructive: recursive delete or disk format (PowerShell)",
      };
    }
    return { kind: "allow" };
  },
};
