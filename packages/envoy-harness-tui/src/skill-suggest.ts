/**
 * R4.6b — skill suggestions for the TUI slash palette.
 */

import {
  rankSkills,
  type RankedSkill,
  type SkillSummary,
} from "@envoymesh/envoy-harness";

/**
 * Suggest skills for a typed query (without leading `/skill `).
 * Returns ranked rows for palette display.
 */
export function matchingSkillSuggestions(
  query: string,
  skills: ReadonlyArray<SkillSummary>,
  limit = 8,
): ReadonlyArray<RankedSkill> {
  return rankSkills(skills, query, {
    limit,
    userInvocableOnly: true,
  });
}
