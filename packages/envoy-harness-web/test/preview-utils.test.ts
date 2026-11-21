import { describe, expect, it } from "vitest";
import {
  isMarkdownPreview,
  maybePrettyJson,
  numberLines,
  previewLanguage,
} from "../src/client/preview-utils.js";

describe("preview-utils", () => {
  it("detects language from path/mime", () => {
    expect(previewLanguage("a.md")).toBe("markdown");
    expect(previewLanguage("x.ts")).toBe("typescript");
    expect(previewLanguage("blob", "image/png")).toBe("image");
    expect(previewLanguage("data.json")).toBe("json");
  });

  it("pretty-prints json when valid", () => {
    expect(maybePrettyJson('{"a":1}', "json")).toContain("\n");
    expect(maybePrettyJson("{", "json")).toBe("{");
    expect(maybePrettyJson("hi", "text")).toBe("hi");
  });

  it("numbers lines and recognizes markdown", () => {
    expect(numberLines("a\nb")).toEqual([
      { n: 1, text: "a" },
      { n: 2, text: "b" },
    ]);
    expect(isMarkdownPreview("markdown")).toBe(true);
  });
});
