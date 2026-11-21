import { describe, expect, it } from "vitest";
import {
  hasTurnHints,
  mergeUniquePaths,
  parseChangedPathsFromSummary,
  parseTurnHints,
  pathsFromApplyPatch,
  pathsFromMutatingTool,
} from "../src/client/composer-docks.js";

describe("composer-docks", () => {
  it("parses changed paths from agent_end summary", () => {
    expect(
      parseChangedPathsFromSummary(
        "done · 2 tools · changed: src/a.ts, packages/b/x.ts",
      ),
    ).toEqual(["src/a.ts", "packages/b/x.ts"]);
    expect(parseChangedPathsFromSummary("done")).toEqual([]);
  });

  it("extracts write/edit/apply_patch paths", () => {
    expect(
      pathsFromMutatingTool("write", { path: "out.txt", content: "x" }),
    ).toEqual(["out.txt"]);
    expect(
      pathsFromMutatingTool("edit", { path: "a.ts", oldText: "a", newText: "b" }),
    ).toEqual(["a.ts"]);
    expect(pathsFromMutatingTool("read", { path: "a.ts" })).toEqual([]);
    expect(
      pathsFromApplyPatch(
        "*** Update File: foo.ts\n*** Add File: bar.ts\n+++ b/baz.ts\n",
      ),
    ).toEqual(["foo.ts", "bar.ts", "baz.ts"]);
  });

  it("parses turnHints wire shape", () => {
    expect(parseTurnHints(null)).toBeNull();
    expect(parseTurnHints({ followUps: [] })).toBeNull();
    const hints = parseTurnHints({
      followUps: ["run tests", "run tests", ""],
      deferred: [{ task: "later", reason: "time" }],
    });
    expect(hasTurnHints(hints)).toBe(true);
    expect(hints?.followUps).toEqual(["run tests"]);
    expect(hints?.deferred).toEqual([{ task: "later", reason: "time" }]);
  });

  it("merges unique paths", () => {
    expect(mergeUniquePaths(["a", "b"], ["b", " c "])).toEqual(["a", "b", "c"]);
  });
});
