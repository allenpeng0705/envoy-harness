/**
 * `envoy-harness tui` delegate — entry resolution + argv parsing.
 */

import { describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli/argv.js";
import { resolveTuiEntry } from "../../src/cli/run/tui.js";

describe("parseArgs tui subcommand", () => {
  it("parses tui with --no-color", () => {
    const a = parseArgs(["tui", "--no-color"]);
    expect(a.subcommand).toBe("tui");
    if (a.subcommand !== "tui") throw new Error("expected tui");
    expect(a.noColor).toBe(true);
  });

  it("rejects unknown tui flags", () => {
    expect(() => parseArgs(["tui", "--bogus"])).toThrow(/unknown flag/);
  });
});

describe("resolveTuiEntry", () => {
  it("includes --spawn in forwarded args", () => {
    const { args } = resolveTuiEntry(["--provider", "openai"]);
    expect(args).toContain("--spawn");
    expect(args).toContain("--provider");
    expect(args).toContain("openai");
  });
});
