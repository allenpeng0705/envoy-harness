/**
 * readOnlyValidation — first of the 6 bash validators (composition in
 * `../index.ts`).
 *
 * **Rule:** if the policy is read-only and the command writes, block.
 *
 * **Detection (heuristic):** any of `>`, `>>`, `tee `, `sed -i`, `\bmv\b`,
 * `\bcp\b`, `\brm\b`, `\btouch\b`, `\bmkdir\b`, `\bchmod\b`.
 *
 * **This is not a parser. It's a heuristic.** The composition of 6 such
 * heuristics is the security story, not any one of them. A user who
 * truly needs to write in read-only mode should be in workspace-write,
 * not bypassing the heuristic.
 *
 * **Design doc:** §6.2 of `docs/design.md`.
 */

import type { BashValidationInput, BashValidator, BashVerdict } from "../../types.js";

/**
 * Match a write redirect: `>` or `>>` at the start of a word, or after
 * a shell operator (`;`, `|`, `(`). The `>` must NOT be preceded by
 * a digit (which would make it `2>`, `1>`, etc. — stderr/fd
 * redirects, not file writes). Also excludes `&>` (combined
 * redirect) and `2>&1` (fd manipulation).
 *
 * Examples:
 * - `echo hi > file`     matches (after space)
 * - `echo hi >> file`    matches (after space, the first `>`)
 * - `ls 2> /dev/null`    does NOT match (digit before `>`)
 * - `cmd 2>&1`           does NOT match (`&` after digit, the `>` is
 *                         part of `>&1` fd manipulation)
 * - `cmd &> file`        does NOT match (`&` precedes `>` directly)
 */
const REDIRECT_PATTERN = /(?:^|[\s;|(\n])>>?/;

const WRITE_PATTERN = new RegExp(
  [
    REDIRECT_PATTERN.source,
    "tee ",
    "sed -i",
    "\\bmv\\b",
    "\\bcp\\b",
    "\\brm\\b",
    "\\btouch\\b",
    "\\bmkdir\\b",
    "\\brmdir\\b",
    "\\bchmod\\b",
    "\\bchown\\b",
    "\\bchgrp\\b",
    "\\bln\\b",
    "\\btruncate\\b",
    "\\bfallocate\\b",
    "\\bmktemp\\b",
    "\\binstall\\b",
    "\\brsync\\b",
  ].join("|"),
  "i",
);

export const readOnlyValidation: BashValidator = {
  name: "read-only",
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (input.policy.mode !== "read-only") return { kind: "allow" };
    if (WRITE_PATTERN.test(input.command)) {
      return { kind: "block", reason: "read-only mode cannot write" };
    }
    return { kind: "allow" };
  },
};
