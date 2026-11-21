/**
 * PowerShell read-only write heuristic.
 */

import type { BashValidationInput, BashValidator, BashVerdict } from "../../types.js";

const WRITE_PATTERN = new RegExp(
  [
    // Redirects (Out-File style and > / >>)
    ">\\s*(?!\\$null\\b)",
    ">>",
    "\\|\\s*Out-File\\b",
    "\\|\\s*Set-Content\\b",
    "\\|\\s*Add-Content\\b",
    "\\|\\s*Tee-Object\\b",
    "\\bOut-File\\b",
    "\\bSet-Content\\b",
    "\\bAdd-Content\\b",
    "\\bNew-Item\\b",
    "\\bRemove-Item\\b",
    "\\bRename-Item\\b",
    "\\bMove-Item\\b",
    "\\bCopy-Item\\b",
    "\\bClear-Content\\b",
    "\\bSet-ItemProperty\\b",
    "\\bNew-ItemProperty\\b",
    "\\bRemove-ItemProperty\\b",
    "\\bni\\b",
    "\\bri\\b",
    "\\bmi\\b",
    "\\bci\\b",
    "\\bdel\\b",
    "\\berase\\b",
    "\\brd\\b",
    "\\brmdir\\b",
    "\\bmd\\b",
    "\\bmkdir\\b",
  ].join("|"),
  "i",
);

export const powerShellReadOnlyValidation: BashValidator = {
  name: "powershell-read-only",
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (input.policy.mode !== "read-only") return { kind: "allow" };
    if (WRITE_PATTERN.test(input.command)) {
      return {
        kind: "block",
        reason: "write intent blocked in read-only mode (PowerShell)",
      };
    }
    return { kind: "allow" };
  },
};
