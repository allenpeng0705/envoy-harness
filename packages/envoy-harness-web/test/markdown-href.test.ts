/**
 * Markdown link href sanitization.
 */
import { describe, expect, it } from "vitest";
import { safeMarkdownHref } from "../src/client/MarkdownBody.js";

describe("safeMarkdownHref", () => {
  it("allows http(s) and mailto", () => {
    expect(safeMarkdownHref("https://example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(safeMarkdownHref("http://example.com")).toBe("http://example.com");
    expect(safeMarkdownHref("mailto:a@b.co")).toBe("mailto:a@b.co");
  });

  it("blocks javascript/data and bare relative paths", () => {
    expect(safeMarkdownHref("javascript:alert(1)")).toBeUndefined();
    expect(safeMarkdownHref("data:text/html,hi")).toBeUndefined();
    expect(safeMarkdownHref("/local/path")).toBeUndefined();
    expect(safeMarkdownHref("#frag")).toBeUndefined();
  });
});
