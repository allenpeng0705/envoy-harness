/**
 * SKILL.md frontmatter parser tests.
 */

import { describe, expect, it } from "vitest";

import { parseFrontmatter, SkillError } from "../../src/skills/index.js";

describe("parseFrontmatter", () => {
  it("parses a minimal valid SKILL.md", () => {
    const raw = `---
name: my-skill
description: A short description.
---
Body line 1.
Body line 2.`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("my-skill");
    expect(frontmatter.description).toBe("A short description.");
    expect(body).toBe("Body line 1.\nBody line 2.");
  });

  it("accepts the when-to-use field", () => {
    const raw = `---
name: deploy
description: Deploy the service.
when-to-use: When the user asks to ship a release.
---
Step 1: run tests.
Step 2: tag.`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.whenToUse).toBe("When the user asks to ship a release.");
  });

  it("preserves extra fields under `extra`", () => {
    const raw = `---
name: my-skill
description: ...
author: Allen Peng
version: 1
---
body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.extra).toEqual({ author: "Allen Peng", version: "1" });
  });

  it("strips surrounding quotes from values", () => {
    const raw = `---
name: 'quoted-name'
description: "double-quoted"
---
body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("quoted-name");
    expect(frontmatter.description).toBe("double-quoted");
  });

  it("rejects when the file is missing frontmatter", () => {
    const raw = `Just a body, no frontmatter.`;
    expect(() => parseFrontmatter(raw)).toThrow(SkillError);
    expect(() => parseFrontmatter(raw)).toThrow(/frontmatter/);
  });

  it("rejects when the frontmatter has no closing fence", () => {
    const raw = `---
name: foo
description: bar
(no closing fence)`;
    expect(() => parseFrontmatter(raw)).toThrow(SkillError);
  });

  it("rejects when name is missing", () => {
    const raw = `---
description: bar
---
body`;
    expect(() => parseFrontmatter(raw)).toThrow(/name/);
  });

  it("rejects when description is missing", () => {
    const raw = `---
name: foo
---
body`;
    expect(() => parseFrontmatter(raw)).toThrow(/description/);
  });

  it("rejects names that do not match the kebab-case regex", () => {
    const raw = `---
name: "Bad Name With Spaces"
description: bar
---
body`;
    expect(() => parseFrontmatter(raw)).toThrow(/name/);
    expect(() => parseFrontmatter(raw)).toThrow(SkillError);
  });

  it("rejects empty names", () => {
    const raw = `---
name: ""
description: bar
---
body`;
    expect(() => parseFrontmatter(raw)).toThrow(SkillError);
  });

  it("ignores comment lines in frontmatter", () => {
    const raw = `---
# this is a comment
name: foo
# another comment
description: bar
---
body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("foo");
    expect(frontmatter.description).toBe("bar");
  });

  it("handles a body that starts with a leading newline", () => {
    // The closing `---` line is followed by `\n` (end of the
    // fence line) and then a leading blank line in the body
    // before the actual content. We strip exactly the line
    // ending of the fence — the blank line is preserved.
    const raw = `---
name: foo
description: bar
---

actual body`;
    const { body } = parseFrontmatter(raw);
    expect(body).toBe("\nactual body");
  });
});
