/**
 * U6 — screen tab strip + colored panel renderers.
 */

import { describe, expect, it } from "vitest";

import { buildViewTabLine, layoutRows } from "../src/screen.js";
import { stripAnsi } from "../src/theme.js";
import {
  renderGitDiffView,
  renderMemoryView,
  renderPlanView,
} from "../src/views.js";

describe("buildViewTabLine", () => {
  it("highlights the active coding tab", () => {
    const line = buildViewTabLine("plan");
    expect(line).toContain("[Plan]");
    expect(line).toContain("Chat");
    expect(line).not.toContain("[Chat]");
  });

  it("maps cluster views to Mesh tab", () => {
    const line = buildViewTabLine("cluster");
    expect(line).toContain("[Mesh]");
  });
});

describe("U6 panel renderers", () => {
  it("renderGitDiffView colors +/- lines when color is enabled", () => {
    const lines = renderGitDiffView("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new", {
      color: true,
    });
    const plain = lines.map(stripAnsi);
    expect(plain.some((l) => l.includes("-old"))).toBe(true);
    expect(plain.some((l) => l.includes("+new"))).toBe(true);
    expect(lines.join("\n")).toMatch(/\x1b\[32m/);
    expect(lines.join("\n")).toMatch(/\x1b\[31m/);
  });

  it("renderPlanView and renderMemoryView include section headers", () => {
    expect(renderPlanView("step 1").join("\n")).toContain("Plan");
    expect(renderMemoryView("mem-1").join("\n")).toContain("Memory");
  });
});

describe("layoutRows with tab line", () => {
  it("allocates a row for the tab strip", () => {
    const rows = layoutRows(
      {
        statusLine: "status",
        railLine: "rail",
        tabLine: "Chat  [Plan]  Memory",
        transcript: ["hello"],
        inputLines: ["> "],
      },
      80,
      10,
    );
    expect(rows[0]).toBe("status");
    expect(rows[1]).toBe("rail");
    expect(rows[2]).toContain("Plan");
  });
});
