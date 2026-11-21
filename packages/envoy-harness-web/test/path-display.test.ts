import { describe, expect, it } from "vitest";
import {
  normalizePathKey,
  pathsEqual,
  shortPathLabel,
} from "../src/client/path-display.js";

describe("path-display", () => {
  it("normalizes Windows separators and drive case", () => {
    expect(normalizePathKey("c:\\Users\\a\\proj")).toBe("C:/Users/a/proj");
    expect(pathsEqual("C:/Users/a", "c:\\Users\\a")).toBe(true);
  });

  it("shortens long unix paths", () => {
    const long = "/Users/me/Documents/mygithub/envoy-harness/packages/web";
    const label = shortPathLabel(long, 40);
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label).toContain("web");
  });
});
