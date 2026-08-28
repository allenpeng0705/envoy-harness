/**
 * Phase B / Item 3.3 — per-plugin config parser tests.
 *
 * **Hermetic:** the parser is pure logic. No I/O,
 * no LLM, no real plugin loading.
 *
 * **Coverage:**
 * 1. `parsePluginConfigEntry("foo.bar=1")` →
 *    `{ name: "foo", key: "bar", value: 1 }` (number).
 * 2. `parsePluginConfigEntry("foo.bar=true")` →
 *    `{ name: "foo", key: "bar", value: true }` (boolean).
 * 3. `parsePluginConfigEntry("foo.bar=hello")` →
 *    `{ name: "foo", key: "bar", value: "hello" }`
 *    (string fallback when JSON.parse throws).
 * 4. `parsePluginConfigEntry('foo.bar="hi there"')` →
 *    `{ name: "foo", key: "bar", value: "hi there" }`
 *    (quoted string).
 * 5. `parsePluginConfigEntry("foo.bar=[1,2,3]")` →
 *    `{ name: "foo", key: "bar", value: [1, 2, 3] }`
 *    (array).
 * 6. `parsePluginConfigEntry("foo.bar=null")` →
 *    `{ name: "foo", key: "bar", value: null }` (null).
 * 7. `parsePluginConfigEntry("nodot")` throws
 *    `PluginConfigParseError` (no `.`).
 * 8. `parsePluginConfigEntry("foo.noequals")` throws
 *    `PluginConfigParseError` (no `=`).
 * 9. `parsePluginConfigEntry("")` throws
 *    `PluginConfigParseError` (empty).
 * 10. `mergePluginConfigs` collapses multiple entries
 *     for the same plugin into a single object.
 * 11. `mergePluginConfigs` with later entries
 *     overwriting earlier ones for the same key.
 * 12. `mergePluginConfigs` with an empty list returns
 *     an empty map.
 */

import { describe, expect, it } from "vitest";

import {
  mergePluginConfigs,
  parsePluginConfigEntry,
  PluginConfigParseError,
  type PluginConfigEntry,
} from "../../src/index.js";

describe("parsePluginConfigEntry: happy path", () => {
  it("parses a number value", () => {
    expect(parsePluginConfigEntry("foo.bar=1")).toEqual({
      name: "foo",
      key: "bar",
      value: 1,
    });
  });

  it("parses a boolean value", () => {
    expect(parsePluginConfigEntry("foo.bar=true")).toEqual({
      name: "foo",
      key: "bar",
      value: true,
    });
    expect(parsePluginConfigEntry("foo.bar=false")).toEqual({
      name: "foo",
      key: "bar",
      value: false,
    });
  });

  it("parses an unquoted string via the JSON-fallback", () => {
    expect(parsePluginConfigEntry("foo.bar=hello")).toEqual({
      name: "foo",
      key: "bar",
      value: "hello",
    });
  });

  it("parses a quoted string", () => {
    expect(parsePluginConfigEntry('foo.bar="hi there"')).toEqual({
      name: "foo",
      key: "bar",
      value: "hi there",
    });
  });

  it("parses an array value", () => {
    expect(parsePluginConfigEntry("foo.bar=[1,2,3]")).toEqual({
      name: "foo",
      key: "bar",
      value: [1, 2, 3],
    });
  });

  it("parses a null value", () => {
    expect(parsePluginConfigEntry("foo.bar=null")).toEqual({
      name: "foo",
      key: "bar",
      value: null,
    });
  });

  it("treats an empty value as the empty string", () => {
    expect(parsePluginConfigEntry("foo.bar=")).toEqual({
      name: "foo",
      key: "bar",
      value: "",
    });
  });
});

describe("parsePluginConfigEntry: malformed input", () => {
  it("throws on a spec with no dot", () => {
    expect(() => parsePluginConfigEntry("nodot")).toThrow(PluginConfigParseError);
    expect(() => parsePluginConfigEntry("nodot")).toThrow(/<name>\.<key>/);
  });

  it("throws on a spec with dot but no equals", () => {
    expect(() => parsePluginConfigEntry("foo.noequals")).toThrow(
      PluginConfigParseError,
    );
    expect(() => parsePluginConfigEntry("foo.noequals")).toThrow(/<name>\.<key>/);
  });

  it("throws on an empty spec", () => {
    expect(() => parsePluginConfigEntry("")).toThrow(PluginConfigParseError);
  });

  it("rejects an empty plugin name (leading dot)", () => {
    // ".key=value" — the first dot is at index 0, so
    // name is empty. We don't enforce this in v0
    // (the parser accepts the empty name; the runner
    // is responsible for cross-checking the name
    // against the `--plugin` list). This test
    // documents the current behavior so a future
    // change is intentional.
    expect(() => parsePluginConfigEntry(".key=1")).not.toThrow();
    expect(parsePluginConfigEntry(".key=1").name).toBe("");
  });
});

describe("mergePluginConfigs", () => {
  it("returns an empty map for an empty entry list", () => {
    expect(mergePluginConfigs([]).size).toBe(0);
  });

  it("groups multiple entries for the same plugin into one record", () => {
    const entries: PluginConfigEntry[] = [
      parsePluginConfigEntry("foo.precision=2"),
      parsePluginConfigEntry("foo.separator=,"),
    ];
    const out = mergePluginConfigs(entries);
    expect(out.get("foo")).toEqual({ precision: 2, separator: "," });
  });

  it("later entries overwrite earlier ones for the same key", () => {
    const entries: PluginConfigEntry[] = [
      parsePluginConfigEntry("foo.precision=2"),
      parsePluginConfigEntry("foo.precision=4"),
    ];
    const out = mergePluginConfigs(entries);
    expect(out.get("foo")).toEqual({ precision: 4 });
  });

  it("keeps separate plugins separate", () => {
    const entries: PluginConfigEntry[] = [
      parsePluginConfigEntry("foo.precision=2"),
      parsePluginConfigEntry("bar.tool=read_file"),
    ];
    const out = mergePluginConfigs(entries);
    expect(out.get("foo")).toEqual({ precision: 2 });
    expect(out.get("bar")).toEqual({ tool: "read_file" });
  });
});
