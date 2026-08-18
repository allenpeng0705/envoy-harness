/**
 * F8.1 tests — ENVOY_HARNESS_SKILLS catalog + tool mapping.
 *
 * Covers:
 * 1. `ENVOY_HARNESS_SKILLS` has all 5 skills with the
 *    correct shape (skillId, description, costCeilingUsd,
 *    maxSensitivity, tags).
 * 2. `getToolsForSkill(skillId)` returns the right tool set
 *    per skill (read-only vs read+write vs exec-only).
 * 3. `isReadOnlySkill(skillId)` correctly identifies the
 *    three read-only skills (code-review, doc-search, plan).
 * 4. Unknown skill IDs return empty tool arrays
 *    (defensive; orchestrator would not send these).
 */

import { describe, expect, it } from "vitest";

import {
  ENVOY_HARNESS_SKILLS,
  ENVOY_HARNESS_VERSION,
  getToolsForSkill,
  isReadOnlySkill,
  type EnvoyHarnessSkillId,
} from "../src/skills.js";

describe("ENVOY_HARNESS_SKILLS catalog", () => {
  it("has exactly 5 skills", () => {
    expect(ENVOY_HARNESS_SKILLS).toHaveLength(5);
  });

  it("includes the 5 expected skill IDs", () => {
    const ids = ENVOY_HARNESS_SKILLS.map((s) => s.skillId).sort();
    expect(ids).toEqual([
      "bash-run",
      "code-edit",
      "code-review",
      "doc-search",
      "plan",
    ]);
  });

  it("each skill has the required fields", () => {
    for (const s of ENVOY_HARNESS_SKILLS) {
      expect(s.skillId).toMatch(/^[a-z][a-z0-9_-]{1,63}$/);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.description.length).toBeLessThanOrEqual(280);
      expect(s.maxSensitivity).toBe("private"); // v0: all private
      expect(Array.isArray(s.tags)).toBe(true);
      expect(s.tags.length).toBeGreaterThan(0);
    }
  });

  it("each skill has a positive cost ceiling", () => {
    for (const s of ENVOY_HARNESS_SKILLS) {
      expect(s.costCeilingUsd).toBeGreaterThan(0);
    }
  });

  it("cost ceilings match the design §11 values", () => {
    const ceilings = Object.fromEntries(
      ENVOY_HARNESS_SKILLS.map((s) => [s.skillId, s.costCeilingUsd]),
    );
    expect(ceilings).toEqual({
      "code-edit": 5.0,
      "code-review": 3.0,
      "doc-search": 1.0,
      "bash-run": 0.5,
      plan: 1.0,
    });
  });
});

describe("getToolsForSkill", () => {
  it("code-edit exposes read_file + bash", () => {
    const tools = [...getToolsForSkill("code-edit")].sort();
    expect(tools).toEqual(["bash", "read_file"]);
  });

  it("code-review exposes only read_file", () => {
    expect(getToolsForSkill("code-review")).toEqual(["read_file"]);
  });

  it("doc-search exposes only read_file", () => {
    expect(getToolsForSkill("doc-search")).toEqual(["read_file"]);
  });

  it("bash-run exposes only bash", () => {
    expect(getToolsForSkill("bash-run")).toEqual(["bash"]);
  });

  it("plan exposes only read_file", () => {
    expect(getToolsForSkill("plan")).toEqual(["read_file"]);
  });

  it("unknown skill ID returns empty array (defensive)", () => {
    expect(getToolsForSkill("not-a-real-skill")).toEqual([]);
  });
});

describe("isReadOnlySkill", () => {
  it("code-edit is NOT read-only (exposes bash)", () => {
    expect(isReadOnlySkill("code-edit")).toBe(false);
  });

  it("code-review is read-only (only read_file)", () => {
    expect(isReadOnlySkill("code-review")).toBe(true);
  });

  it("doc-search is read-only", () => {
    expect(isReadOnlySkill("doc-search")).toBe(true);
  });

  it("bash-run is NOT read-only (exposes bash)", () => {
    expect(isReadOnlySkill("bash-run")).toBe(false);
  });

  it("plan is read-only", () => {
    expect(isReadOnlySkill("plan")).toBe(true);
  });

  it("unknown skill ID is treated as read-only (empty tools)", () => {
    expect(isReadOnlySkill("not-a-real-skill")).toBe(true);
  });
});

describe("ENVOY_HARNESS_VERSION", () => {
  it("is the current package version", () => {
    expect(ENVOY_HARNESS_VERSION).toBe("0.0.0");
  });
});

describe("EnvoyHarnessSkillId literal union", () => {
  it("matches the 5 catalog IDs", () => {
    const ids: EnvoyHarnessSkillId[] = [
      "code-edit",
      "code-review",
      "doc-search",
      "bash-run",
      "plan",
    ];
    expect(new Set(ids).size).toBe(5);
  });
});
