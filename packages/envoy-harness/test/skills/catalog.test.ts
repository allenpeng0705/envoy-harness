/**
 * Phase G — skill catalog projection (deepseek's model-facing catalog).
 */

import { describe, expect, it } from "vitest";

import {
  createSkillCatalogFragment,
  nextCatalogMessage,
  renderSkillCatalog,
  skillCatalogDigest,
} from "../../src/skills/index.js";
import type { SkillSummary } from "../../src/skills/types.js";

function summary(name: string, description: string): SkillSummary {
  return {
    name,
    description,
    provider: "test",
    invocation: { modelInvocable: true, userInvocable: true },
  };
}

describe("renderSkillCatalog", () => {
  it("renders the <available_skills> block sorted by name", () => {
    const text = renderSkillCatalog([
      summary("zebra", "striped"),
      summary("alpha", "first"),
    ]);
    expect(text).toContain("<available_skills>");
    expect(text).toContain('<skill name="alpha">first</skill>');
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("zebra"));
    expect(text).toContain("</available_skills>");
  });

  it("caps entries and truncates long descriptions with a marker", () => {
    const text = renderSkillCatalog(
      [summary("a", "x".repeat(500)), summary("b", "y"), summary("c", "z")],
      { maxEntries: 2, maxDescriptionChars: 20 },
    );
    expect(text).toContain("1 more skills");
    expect(text).not.toContain("z"); // the third (dropped) entry
    expect(text).toContain("xxxxx…");
  });

  it("escapes XML metacharacters in names and descriptions", () => {
    const text = renderSkillCatalog([summary('a&"b', "d<e>")]);
    expect(text).toContain("a&amp;&quot;b");
    expect(text).toContain("d&lt;e&gt;");
  });
});

describe("skillCatalogDigest + nextCatalogMessage", () => {
  it("is stable for the same set and changes with membership", () => {
    const a = [summary("a", "1")];
    const b = [summary("a", "1"), summary("b", "2")];
    expect(skillCatalogDigest(a)).toBe(skillCatalogDigest([summary("a", "1")]));
    expect(skillCatalogDigest(a)).not.toBe(skillCatalogDigest(b));
  });

  it("re-publishes only on change (deepseek digest semantics)", () => {
    const first = nextCatalogMessage([summary("a", "1")], undefined);
    expect(first.changed).toBe(true);
    expect(first.text).toContain("available_skills");

    const same = nextCatalogMessage([summary("a", "1")], first.digest);
    expect(same.changed).toBe(false);
    expect(same.text).toBe("");

    const changed = nextCatalogMessage(
      [summary("a", "1"), summary("b", "2")],
      first.digest,
    );
    expect(changed.changed).toBe(true);
    expect(changed.text).toContain('name="b"');
  });
});

describe("createSkillCatalogFragment", () => {
  it("produces a bounded user-role fragment", () => {
    const fragment = createSkillCatalogFragment([
      summary("a", "1"),
      summary("b", "2"),
    ]);
    expect(fragment.id).toBe("skill-catalog");
    expect(fragment.owner).toBe("skills");
    expect(fragment.render()).toContain("<available_skills>");
    expect(fragment.estimatedTokens).toBeGreaterThan(0);
  });
});
