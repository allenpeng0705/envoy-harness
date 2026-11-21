/**
 * PowerShell network / mode heuristic.
 */

import type { BashValidationInput, BashValidator, BashVerdict } from "../../types.js";

const NETWORK_PATTERN =
  /\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\bcurl\.exe\b|\bwget\.exe\b|\bStart-BitsTransfer\b|\bNew-WebServiceProxy\b|\bssh\b|\bscp\b|\bTest-NetConnection\b/i;

export const powerShellModeValidation: BashValidator = {
  name: "powershell-mode",
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (!input.policy.networkAccess && NETWORK_PATTERN.test(input.command)) {
      return { kind: "block", reason: "network disabled in this mode (PowerShell)" };
    }
    return { kind: "allow" };
  },
};
