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
  it("has exactly 8 skills (5 envoy-harness + 3 B-class)", () => {
    // Phase 8 / Step 3 commit 2 — the catalog grew from
    // 5 to 8 with the addition of 3 B-class skills
    // (setup-sponsor-friend / peer-list / relay-status).
    // Both runtimes advertise the same 3 B-class skills
    // per the "invoking-runtime tag" decision; see
    // `docs/agent-harness-integration-step3.md` §3.4
    // (EnvoyMesh monorepo) for the rationale.
    expect(ENVOY_HARNESS_SKILLS).toHaveLength(8);
  });

  it("includes the 8 expected skill IDs", () => {
    const ids = ENVOY_HARNESS_SKILLS.map((s) => s.skillId).sort();
    expect(ids).toEqual([
      "bash-run",
      "code-edit",
      "code-review",
      "doc-search",
      "peer-list",
      "plan",
      "relay-status",
      "setup-sponsor-friend",
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

  it("cost ceilings match the design §11 values (5 envoy-harness + 3 B-class)", () => {
    const ceilings = Object.fromEntries(
      ENVOY_HARNESS_SKILLS.map((s) => [s.skillId, s.costCeilingUsd]),
    );
    expect(ceilings).toEqual({
      "code-edit": 5.0,
      "code-review": 3.0,
      "doc-search": 1.0,
      "bash-run": 0.5,
      plan: 1.0,
      // Phase 8 / Step 3 — B-class skill cost ceilings.
      // The bridge's own algorithm can run for 6+
      // minutes (12 attempts × 30s+), so the soft
      // ceiling is conservative ($1); the
      // observability skills are cheaper ($0.1 each).
      "setup-sponsor-friend": 1.0,
      "peer-list": 0.1,
      "relay-status": 0.1,
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
  it("matches the 8 catalog IDs", () => {
    // Phase 8 / Step 3 commit 2 — the literal union
    // grew to 8 (5 envoy-harness + 3 B-class).
    // Note: `EnvoyHarnessSkillId` is the *adapter-
    // internal* union (for the tool-name mapping in
    // `getToolsForSkill`); the wire-side `skillId`
    // is a plain `string` (per `@envoymesh/protocol`).
    // The 3 B-class skill IDs here are the kebab-case
    // string IDs, not the snake_case tool names
    // (`sponsor_friend` / `list_peers` / `relay_status`
    // live in `EnvoyHarnessToolName`).
    const ids: EnvoyHarnessSkillId[] = [
      "code-edit",
      "code-review",
      "doc-search",
      "bash-run",
      "plan",
      "setup-sponsor-friend",
      "peer-list",
      "relay-status",
    ];
    expect(new Set(ids).size).toBe(8);
  });
});
