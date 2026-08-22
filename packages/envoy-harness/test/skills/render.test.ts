/**
 * SKILL.md render tests.
 */

import { describe, expect, it } from "vitest";

import { renderSkillContent } from "../../src/skills/index.js";
import type { SkillDefinition } from "../../src/skills/index.js";

const sample: SkillDefinition = {
  name: "deploy",
  description: "Deploy the service.",
  whenToUse: "When the user asks to ship a release.",
  provider: "project:envoy",
  invocation: { modelInvocable: true, userInvocable: true },
  resourceBase: "/proj/.envoy/skills/deploy",
  instructions: "Step 1: run tests.\nStep 2: tag.",
};

describe("renderSkillContent", () => {
  it("emits the canonical <skill_content> block", () => {
    const out = renderSkillContent(sample);
    expect(out).toContain("<skill_content>");
    expect(out).toContain("<name>deploy</name>");
    expect(out).toContain("<description>Deploy the service.</description>");
    expect(out).toContain(
      "<when_to_use>When the user asks to ship a release.</when_to_use>",
    );
    expect(out).toContain("<provider>project:envoy</provider>");
    expect(out).toContain("<body>");
    expect(out).toContain("</body>");
    expect(out).toContain("</skill_content>");
  });

  it("indents the body for readability", () => {
    const out = renderSkillContent(sample);
    expect(out).toContain("  Step 1: run tests.");
  });

  it("escapes XML-significant characters", () => {
    const xss: SkillDefinition = {
      ...sample,
      name: "evil",
      description: "<script>alert(1)</script>",
    };
    const out = renderSkillContent(xss);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("omits whenToUse when not set", () => {
    // Build without the field at all (exactOptionalPropertyTypes
    // forbids assigning `undefined` to an optional `string`).
    const { whenToUse: _ignore, ...rest } = sample;
    const minimal: SkillDefinition = { ...rest };
    const out = renderSkillContent(minimal);
    expect(out).not.toContain("<when_to_use>");
  });
});
