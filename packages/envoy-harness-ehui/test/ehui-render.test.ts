/**
 * R7.1 — structured Plan / Memory / Diff line builders.
 */

import { describe, expect, it } from "vitest";

import {
  buildGitDiffLines,
  buildMemoryLines,
  buildPlanLines,
  ehuiLineClassName,
} from "../src/ehui-render.js";

describe("buildPlanLines", () => {
  it("shows empty hint when blank", () => {
    const lines = buildPlanLines("  ");
    expect(lines[0]?.kind).toBe("header");
    expect(lines[1]).toEqual({ kind: "hint", text: "empty — use /plan enter" });
  });

  it("indents body under header", () => {
    const lines = buildPlanLines("step one\nstep two");
    expect(lines.map((l) => l.kind)).toEqual(["header", "body", "body"]);
    expect(lines[1]?.text).toBe("step one");
  });
});

describe("buildMemoryLines", () => {
  it("headers memory list", () => {
    const lines = buildMemoryLines("notes.md");
    expect(lines[0]?.text).toContain("Memory");
    expect(lines[1]?.kind).toBe("body");
  });
});

describe("buildGitDiffLines", () => {
  it("marks clean tree", () => {
    const lines = buildGitDiffLines("");
    expect(lines[1]).toEqual({ kind: "hint", text: "clean working tree" });
  });

  it("classifies +/-/@@ lines", () => {
    const lines = buildGitDiffLines(
      ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old", "+new", " ctx"].join("\n"),
    );
    const kinds = lines.slice(1).map((l) => l.kind);
    expect(kinds).toEqual([
      "diff-meta",
      "diff-meta",
      "diff-hunk",
      "diff-del",
      "diff-add",
      "diff-ctx",
    ]);
    expect(ehuiLineClassName("diff-add")).toBe("ehui-line ehui-line--diff-add");
  });
});
