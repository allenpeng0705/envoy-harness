/**
 * Tests for `src/memories/citations.ts` — the
 * citation parser + renderer.
 *
 * Covers:
 * 1. `[memory:foo.md]` → `{ name: "foo.md" }`.
 * 2. `[memory:foo.md#Setup]` → `{ name: "foo.md", anchor: "Setup" }`.
 * 3. Multiple citations in one string are extracted
 *    in order.
 * 4. A non-citation string returns `[]`.
 * 5. `renderCitation(parseCitation(x)) === x` for
 *    valid citations.
 * 6. `slugify` matches the GitHub-flavored convention.
 */

import { describe, expect, it } from "vitest";

import {
  parseCitation,
  renderCitation,
  slugify,
} from "../../src/memories/citations.js";

describe("parseCitation", () => {
  it("extracts a whole-file citation", () => {
    const out = parseCitation("see [memory:foo] for details");
    expect(out).toEqual([{ name: "foo" }]);
  });

  it("extracts a section citation", () => {
    const out = parseCitation("see [memory:foo#Setup] for details");
    expect(out).toEqual([{ name: "foo", anchor: "Setup" }]);
  });

  it("extracts multiple citations in order", () => {
    const out = parseCitation(
      "first [memory:a] then [memory:b#Section] then [memory:c]",
    );
    expect(out).toEqual([
      { name: "a" },
      { name: "b", anchor: "Section" },
      { name: "c" },
    ]);
  });

  it("returns an empty array for text with no citations", () => {
    expect(parseCitation("hello world")).toEqual([]);
    expect(parseCitation("")).toEqual([]);
  });

  it("rejects malformed citations", () => {
    // No closing bracket, no name, etc.
    expect(parseCitation("[memory:]")).toEqual([]);
    expect(parseCitation("[memory:Invalid Name]")).toEqual([]);
    expect(parseCitation("[memory:foo")).toEqual([]);
    expect(parseCitation("memory:foo]")).toEqual([]);
  });

  it("supports a name with dashes and digits", () => {
    expect(parseCitation("[memory:foo-bar-2]")).toEqual([
      { name: "foo-bar-2" },
    ]);
  });
});

describe("renderCitation", () => {
  it("renders a whole-file citation", () => {
    expect(renderCitation({ name: "foo" })).toBe("[memory:foo]");
  });

  it("renders a section citation", () => {
    expect(renderCitation({ name: "foo", anchor: "Setup" })).toBe(
      "[memory:foo#Setup]",
    );
  });

  it("treats an empty anchor as a whole-file citation", () => {
    expect(renderCitation({ name: "foo", anchor: "" })).toBe("[memory:foo]");
  });
});

describe("parse + render round-trip", () => {
  it("round-trips a whole-file citation", () => {
    const original = "see [memory:foo] for details";
    const citations = parseCitation(original);
    expect(citations).toHaveLength(1);
    expect(renderCitation(citations[0]!)).toBe("[memory:foo]");
  });

  it("round-trips a section citation", () => {
    const original = "see [memory:foo#Setup] for details";
    const citations = parseCitation(original);
    expect(citations).toHaveLength(1);
    expect(renderCitation(citations[0]!)).toBe("[memory:foo#Setup]");
  });
});

describe("slugify", () => {
  it("lowercases and replaces spaces with dashes", () => {
    expect(slugify("How to Bootstrap")).toBe("how-to-bootstrap");
  });

  it("drops punctuation", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("collapses runs of spaces and dashes", () => {
    expect(slugify("a  b---c")).toBe("a-b-c");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("--foo--")).toBe("foo");
  });

  it("preserves digits", () => {
    expect(slugify("Setup: 1.2.x")).toBe("setup-12x");
  });
});
