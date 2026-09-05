/**
 * R4.6b — skill fuzzy ranker hermetic tests.
 */

import { describe, expect, it } from "vitest";

import {
  isSubsequenceMatch,
  rankSkills,
  type SkillSummary,
} from "../../src/index.js";

function skill(name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name,
    description: `${name} skill`,
    provider: "test",
    invocation: { modelInvocable: true, userInvocable: true },
    ...overrides,
  };
}

const CATALOG = [
  skill("zebra-report"),
  skill("git-commit"),
  skill("git-status"),
  skill("code-review"),
  skill("research"),
];

describe("R4.6b rankSkills", () => {
  it("empty query returns catalog order", () => {
    const ranked = rankSkills(CATALOG, "");
    expect(ranked.map((r) => r.summary.name)).toEqual([
      "code-review",
      "git-commit",
      "git-status",
      "research",
      "zebra-report",
    ]);
    expect(ranked.every((r) => r.tier === "catalog")).toBe(true);
  });

  it("prefix matches rank before fuzzy and catalog", () => {
    const ranked = rankSkills(CATALOG, "git");
    expect(ranked[0]!.tier).toBe("prefix");
    expect(ranked[0]!.summary.name).toBe("git-commit");
    expect(ranked[1]!.summary.name).toBe("git-status");
    // Non-prefix come after (fuzzy or catalog)
    expect(ranked.slice(0, 2).every((r) => r.tier === "prefix")).toBe(true);
  });

  it("fuzzy subsequence matches after prefix", () => {
    const ranked = rankSkills(CATALOG, "crv");
    // code-review matches c-r-v as subsequence; no prefix "crv"
    const code = ranked.find((r) => r.summary.name === "code-review");
    expect(code?.tier).toBe("fuzzy");
    const firstNonPrefix = ranked.find((r) => r.tier !== "prefix");
    expect(firstNonPrefix?.summary.name).toBe("code-review");
  });

  it("exact name beats longer prefix", () => {
    const ranked = rankSkills(
      [skill("git"), skill("git-status"), skill("github")],
      "git",
    );
    expect(ranked[0]!.summary.name).toBe("git");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("respects limit and userInvocableOnly", () => {
    const mixed = [
      skill("alpha", {
        invocation: { modelInvocable: true, userInvocable: false },
      }),
      skill("beta"),
      skill("gamma"),
    ];
    const ranked = rankSkills(mixed, "", {
      userInvocableOnly: true,
      limit: 1,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.summary.name).toBe("beta");
  });
});

describe("isSubsequenceMatch", () => {
  it("matches characters in order", () => {
    expect(isSubsequenceMatch("code-review", "crv")).toBe(true);
    expect(isSubsequenceMatch("code-review", "xyz")).toBe(false);
  });
});
