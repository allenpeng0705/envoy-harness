/**
 * F9.3.1 tests — `parseTeamToml` (the minimal TOML
 * reader for team configs).
 *
 * Covers:
 * 1. Minimal valid config (one agent, no schedule).
 * 2. Multiple agents with `depends_on`.
 * 3. Schedule with a 5-field cron expression.
 * 4. Comments and blank lines.
 * 5. String escapes (`\\`, `\"`, `\n`, `\t`).
 * 6. Empty arrays.
 * 7. Error cases: missing name, missing agents,
 *    invalid cron (not 5 fields), invalid array
 *    element, missing required field, etc.
 */

import { describe, expect, it } from "vitest";

import {
  parseTeamToml,
  TomlParseError,
  type TeamConfig,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// 1. Minimal valid config
// ---------------------------------------------------------------------------

describe("parseTeamToml — minimal valid config", () => {
  it("parses an optional host field (D4 distributed team)", () => {
    const toml = `
name = "distributed"

[[agents]]
id = "a"
role = "worker"
objective = "do it"
host = "peer://p1"
depends_on = []
`;
    const config = parseTeamToml(toml);
    expect(config.agents[0]?.host).toBe("peer://p1");
  });

  it("rejects a non-string host field", () => {
    const toml = `
name = "broken"

[[agents]]
id = "a"
role = "worker"
objective = "x"
host = 42
depends_on = []
`;
    // The TOML layer may reject the non-string value before our check;
    // either way it must not produce a config with a numeric host.
    expect(() => parseTeamToml(toml)).toThrow();
  });

  it("parses a single agent with no dependencies", () => {
    const toml = `
name = "code-review"

[[agents]]
id = "explore"
role = "explore"
system_prompt = "You explore the codebase."
objective = "Find relevant files."
depends_on = []
`;
    const config = parseTeamToml(toml);
    expect(config.name).toBe("code-review");
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0]?.id).toBe("explore");
    expect(config.agents[0]?.role).toBe("explore");
    expect(config.agents[0]?.systemPrompt).toBe("You explore the codebase.");
    expect(config.agents[0]?.objective).toBe("Find relevant files.");
    expect(config.agents[0]?.dependsOn).toEqual([]);
    expect(config.schedule).toBeUndefined();
  });

  it("treats missing `depends_on` as empty array", () => {
    const toml = `
name = "t"

[[agents]]
id = "a"
role = "r"
system_prompt = "sp"
objective = "o"
`;
    const config = parseTeamToml(toml);
    expect(config.agents[0]?.dependsOn).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Multiple agents
// ---------------------------------------------------------------------------

describe("parseTeamToml — multiple agents", () => {
  it("parses multiple agents with depends_on", () => {
    const toml = `
name = "t"

[[agents]]
id = "explore"
role = "explore"
system_prompt = "sp"
objective = "o"
depends_on = []

[[agents]]
id = "review"
role = "review"
system_prompt = "sp2"
objective = "o2"
depends_on = ["explore"]

[[agents]]
id = "summarize"
role = "summarize"
system_prompt = "sp3"
objective = "o3"
depends_on = ["explore", "review"]
`;
    const config: TeamConfig = parseTeamToml(toml);
    expect(config.agents).toHaveLength(3);
    expect(config.agents[1]?.dependsOn).toEqual(["explore"]);
    expect(config.agents[2]?.dependsOn).toEqual(["explore", "review"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Schedule
// ---------------------------------------------------------------------------

describe("parseTeamToml — schedule", () => {
  it("parses a 5-field cron expression", () => {
    const toml = `
name = "t"

[schedule]
cron = "0 9 * * *"

[[agents]]
id = "a"
role = "r"
system_prompt = "sp"
objective = "o"
`;
    const config = parseTeamToml(toml);
    expect(config.schedule?.cron).toBe("0 9 * * *");
  });

  it("rejects a cron expression with the wrong number of fields", () => {
    const toml = `
name = "t"

[schedule]
cron = "0 9 *"

[[agents]]
id = "a"
role = "r"
system_prompt = "sp"
objective = "o"
`;
    expect(() => parseTeamToml(toml)).toThrow(/5-field cron/);
  });
});

// ---------------------------------------------------------------------------
// 4. Comments + blank lines
// ---------------------------------------------------------------------------

describe("parseTeamToml — comments + blank lines", () => {
  it("ignores full-line comments and blank lines", () => {
    const toml = `
# This is a comment
name = "t"

# Another comment
[[agents]]
# Yet another comment
id = "a"
role = "r"
system_prompt = "sp"
objective = "o"
`;
    const config = parseTeamToml(toml);
    expect(config.name).toBe("t");
    expect(config.agents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. String escapes
// ---------------------------------------------------------------------------

describe("parseTeamToml — string escapes", () => {
  it("handles backslash, quote, newline, tab escapes", () => {
    const toml = `
name = "t"

[[agents]]
id = "a"
role = "r"
system_prompt = "line1\\nline2\\twith quote\\""
objective = "o"
`;
    const config = parseTeamToml(toml);
    expect(config.agents[0]?.systemPrompt).toBe('line1\nline2\twith quote"');
  });
});

// ---------------------------------------------------------------------------
// 6. Empty arrays
// ---------------------------------------------------------------------------

describe("parseTeamToml — arrays", () => {
  it("parses an empty string array as []", () => {
    const toml = `
name = "t"

[[agents]]
id = "a"
role = "r"
system_prompt = "sp"
objective = "o"
depends_on = []
`;
    const config = parseTeamToml(toml);
    expect(config.agents[0]?.dependsOn).toEqual([]);
  });

  it("parses a non-empty string array", () => {
    const toml = `
name = "t"

[[agents]]
id = "a"
role = "r"
system_prompt = "sp"
objective = "o"
depends_on = ["x", "y", "z"]
`;
    const config = parseTeamToml(toml);
    expect(config.agents[0]?.dependsOn).toEqual(["x", "y", "z"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Error cases
// ---------------------------------------------------------------------------

describe("parseTeamToml — error cases", () => {
  it("throws on missing name", () => {
    const toml = `
[[agents]]
id = "a"
role = "r"
system_prompt = "sp"
objective = "o"
`;
    expect(() => parseTeamToml(toml)).toThrow(/missing or invalid `name`/);
  });

  it("throws on missing agents", () => {
    const toml = `
name = "t"
`;
    expect(() => parseTeamToml(toml)).toThrow(/missing or empty/);
  });

  it("throws on empty agents array", () => {
    const toml = `
name = "t"

[[agents]]
`;
    expect(() => parseTeamToml(toml)).toThrow(/agents\[0\]/);
  });

  it("throws on invalid key (contains space)", () => {
    const toml = `
name = "t"

[[agents]]
id = "a"
role = "r"
"system prompt" = "sp"
objective = "o"
`;
    expect(() => parseTeamToml(toml)).toThrow(/invalid key/);
  });

  it("throws on non-string value (integer in v0)", () => {
    const toml = `
name = 42
`;
    expect(() => parseTeamToml(toml)).toThrow(/must be a string/);
  });

  it("throws on non-string array element", () => {
    const toml = `
name = "t"

[[agents]]
id = "a"
role = "r"
system_prompt = "sp"
objective = "o"
depends_on = [42]
`;
    expect(() => parseTeamToml(toml)).toThrow(/must be a string/);
  });

  it("TomlParseError includes line number + line content", () => {
    const toml = `
name = "t"
not valid
`;
    try {
      parseTeamToml(toml);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TomlParseError);
      const err = e as TomlParseError;
      expect(err.lineNumber).toBe(3);
      expect(err.line).toBe("not valid");
    }
  });

  it("throws on unclosed string", () => {
    const toml = `
name = "t
`;
    expect(() => parseTeamToml(toml)).toThrow();
  });
});
