/**
 * commandSemanticsValidation — sixth of the 6 bash validators.
 *
 * **Rule:** the command must be syntactically sane. Block if it has
 * unbalanced quotes or unescaped backticks.
 *
 * **Why this matters:** shell injection attacks often rely on
 * malformed quoting. A user typing `rm -rf /` is intentional; a
 * tool output that contains `"; rm -rf /` is suspicious. The
 * semantics validator catches the second kind.
 *
 * **Limitations:** this is a heuristic. It does not parse shell. A
 * user who writes `echo "hello"` with one missing closing quote is
 * blocked. A user who writes `printf '%s' "abc" "def"` (even count)
 * is allowed. False positives are rare; false negatives are caught
 * by the next layer (the actual shell will reject the malformed
 * command).
 *
 * **Design doc:** §6.2 of `docs/design.md`.
 */

import type { BashValidationInput, BashValidator, BashVerdict } from "../../types.js";

/**
 * Count single and double quotes in a string. Return true if either
 * count is odd (unbalanced).
 *
 * Note: this is a naive count; it doesn't handle escaped quotes inside
 * the same string. For a stricter check, a proper shell parser would
 * be needed. The current behavior errs on the side of "block
 * ambiguous" rather than "allow dangerous".
 */
export function hasUnbalancedQuotes(command: string): boolean {
  let singleCount = 0;
  let doubleCount = 0;
  for (const ch of command) {
    if (ch === "'") singleCount++;
    else if (ch === '"') doubleCount++;
  }
  return singleCount % 2 === 1 || doubleCount % 2 === 1;
}

/**
 * Check for backtick characters. Backticks in bash invoke command
 * substitution (`echo $(date)` is preferred, but legacy code uses
 * `` `date` ``). Most agents should use `$(...)` instead; blocking
 * backticks forces a cleaner style and prevents a class of
 * injection.
 */
export function containsBackticks(command: string): boolean {
  return command.includes("`");
}

export const commandSemanticsValidation: BashValidator = {
  name: "command-semantics",
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (hasUnbalancedQuotes(input.command)) {
      return { kind: "block", reason: "unbalanced quotes" };
    }
    if (containsBackticks(input.command)) {
      return { kind: "block", reason: "backticks not allowed" };
    }
    return { kind: "allow" };
  },
};
