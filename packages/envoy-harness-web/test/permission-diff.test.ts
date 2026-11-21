import { describe, expect, it } from "vitest";
import {
  buildPermissionDiffPreview,
  permissionTargetPath,
} from "../src/client/permission-diff.js";

describe("permission-diff", () => {
  it("builds edit old/new hunks", () => {
    const preview = buildPermissionDiffPreview("edit", {
      path: "a.ts",
      oldText: "a\nb",
      newText: "a\nc",
    });
    expect(preview?.kind).toBe("edit");
    expect(preview?.diff).toContain("- b");
    expect(preview?.diff).toContain("+ c");
    expect(permissionTargetPath("edit", { path: "a.ts" })).toBe("a.ts");
  });

  it("builds write preview with optional before", () => {
    const neu = buildPermissionDiffPreview("write", {
      path: "n.txt",
      content: "hello",
    });
    expect(neu?.diff).toContain("new file");
    expect(neu?.diff).toContain("hello");

    const over = buildPermissionDiffPreview(
      "write",
      { path: "n.txt", content: "hello" },
      "old",
    );
    expect(over?.diff).toContain("- old");
    expect(over?.diff).toContain("+ hello");
  });

  it("truncates apply_patch text", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const preview = buildPermissionDiffPreview("apply_patch", {
      patch: lines,
    });
    expect(preview?.kind).toBe("patch");
    expect(preview?.diff).toContain("more lines");
  });

  it("returns null for unknown tools without paths", () => {
    expect(buildPermissionDiffPreview("memory", { x: 1 })).toBeNull();
  });
});
