import { describe, expect, it } from "vitest";
import {
  FALLBACK_SLASH_CATALOG,
  filterSlashCatalog,
} from "../src/client/slash-catalog.js";

describe("slash-catalog", () => {
  it("filters by prefix", () => {
    const hits = filterSlashCatalog(FALLBACK_SLASH_CATALOG, "/comp");
    expect(hits.some((h) => h.name === "compact")).toBe(true);
  });

  it("returns empty when not a slash draft", () => {
    expect(filterSlashCatalog(FALLBACK_SLASH_CATALOG, "hello")).toEqual([]);
  });

  it("closes palette once slash args are present", () => {
    expect(filterSlashCatalog(FALLBACK_SLASH_CATALOG, "/schedule list")).toEqual(
      [],
    );
  });
});
