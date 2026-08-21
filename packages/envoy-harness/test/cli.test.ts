/**
 * CLI tests.
 *
 * Covers argv parsing (the parser is the part most likely to
 * silently break on a new flag) and the runner (with a fake
 * model — production adapters are a separate concern).
 */

import { describe, expect, it } from "vitest";

import {
  ArgvError,
  CliError,
  parseArgs,
  run,
  type ContentBlock,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.js";
import { StringWritable } from "./helpers.js";

describe("parseArgs", () => {
  // Helper: parseArgs and narrow to the run subcommand shape.
  function parseRun(argv: ReadonlyArray<string>) {
    const a = parseArgs(argv);
    if (a.subcommand !== "run") {
      throw new Error(`expected run subcommand, got ${a.subcommand}`);
    }
    return a;
  }

  it("returns defaults for empty argv", () => {
    const a = parseRun([]);
    expect(a.help).toBe(false);
    expect(a.sandbox).toBeUndefined();
    expect(a.positional).toEqual([]);
  });

  it("captures --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("captures --version", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it("captures --json", () => {
    expect(parseRun(["--json"]).json).toBe(true);
  });

  it("captures --plan, --no-color, --verbose, --quiet as booleans", () => {
    expect(parseRun(["--plan"]).plan).toBe(true);
    expect(parseRun(["--no-color"]).noColor).toBe(true);
    expect(parseRun(["--verbose"]).verbose).toBe(true);
    expect(parseRun(["--quiet"]).quiet).toBe(true);
  });

  it("parses --sandbox with a value, validates the value", () => {
    expect(parseRun(["--sandbox", "read-only"]).sandbox).toBe("read-only");
    expect(parseRun(["--sandbox", "workspace-write"]).sandbox).toBe(
      "workspace-write",
    );
    expect(parseRun(["--sandbox", "danger-full-access"]).sandbox).toBe(
      "danger-full-access",
    );
    expect(() => parseArgs(["--sandbox", "bogus"])).toThrow(ArgvError);
  });

  it("parses --max-turns as a positive number", () => {
    expect(parseRun(["--max-turns", "10"]).maxTurns).toBe(10);
    expect(() => parseArgs(["--max-turns", "0"])).toThrow(ArgvError);
    expect(() => parseArgs(["--max-turns", "abc"])).toThrow(ArgvError);
  });

  it("parses --max-cost-usd allowing zero", () => {
    expect(parseRun(["--max-cost-usd", "0"]).maxCostUsd).toBe(0);
    expect(parseRun(["--max-cost-usd", "5.5"]).maxCostUsd).toBe(5.5);
    expect(() => parseArgs(["--max-cost-usd", "-1"])).toThrow(ArgvError);
  });

  it("captures --model, --provider, --cwd, --resume, --fork", () => {
    expect(parseRun(["--model", "claude-opus-4"]).model).toBe("claude-opus-4");
    expect(parseRun(["--provider", "anthropic"]).provider).toBe("anthropic");
    expect(parseRun(["--cwd", "/tmp"]).cwd).toBe("/tmp");
    expect(parseRun(["--resume", "abc"]).resume).toBe("abc");
    expect(parseRun(["--fork", "abc"]).fork).toBe("abc");
  });

  it("collects positional args", () => {
    const a = parseRun(["hello", "world"]);
    expect(a.positional).toEqual(["hello", "world"]);
  });

  it("supports flags interspersed with positional", () => {
    const a = parseRun(["--quiet", "hi", "--json", "there"]);
    expect(a.quiet).toBe(true);
    expect(a.json).toBe(true);
    expect(a.positional).toEqual(["hi", "there"]);
  });

  it("throws on unknown flags", () => {
    expect(() => parseArgs(["--not-a-flag"])).toThrow(ArgvError);
  });

  it("rejects invalid --approval values", () => {
    expect(() => parseArgs(["--approval", "maybe"])).toThrow(/invalid --approval/);
    expect(() => parseArgs(["--approval", "never"])).not.toThrow();
  });

  it("throws when a valued flag has no value", () => {
    expect(() => parseArgs(["--sandbox"])).toThrow(ArgvError);
    expect(() => parseArgs(["--model"])).toThrow(ArgvError);
  });

  // Phase B / Item 15.1: --import-config + --from.
  it("captures --import-config and --from as valued flags", () => {
    const a = parseRun([
      "--import-config", "/tmp/codex.toml",
      "--from", "codex",
    ]);
    expect(a.importConfig).toBe("/tmp/codex.toml");
    expect(a.importFrom).toBe("codex");
  });

  it("--import-config + --from work in any flag order", () => {
    const a = parseRun([
      "--from", "codex",
      "--import-config", "/etc/codex.toml",
    ]);
    expect(a.importConfig).toBe("/etc/codex.toml");
    expect(a.importFrom).toBe("codex");
  });

  it("throws when --import-config or --from has no value", () => {
    expect(() => parseArgs(["--import-config"])).toThrow(ArgvError);
    expect(() => parseArgs(["--from"])).toThrow(ArgvError);
  });

  // Phase B / Item 3.1: --plugin is a repeatable valued
  // flag. Each occurrence appends to the plugins list.
  it("captures --plugin (repeatable) as a list", () => {
    const a = parseRun(["--plugin", "alpha", "--plugin", "beta"]);
    if (a.subcommand !== "run") throw new Error("expected run");
    expect(a.plugins).toEqual(["alpha", "beta"]);
  });

  it("defaults plugins to an empty array when --plugin is absent", () => {
    const a = parseRun(["hello"]);
    if (a.subcommand !== "run") throw new Error("expected run");
    expect(a.plugins).toEqual([]);
  });

  it("throws when --plugin has no value", () => {
    expect(() => parseArgs(["--plugin"])).toThrow(ArgvError);
  });

  // Phase B / Item 3.3: --plugin-config is a
  // repeatable valued flag. Each occurrence parses
  // `<name>.<key>=<value>` and appends to the
  // `pluginConfigs` list.
  it("captures --plugin-config (repeatable) as a list of entries", () => {
    const a = parseArgs([
      "--plugin-config", "alpha.precision=2",
      "--plugin-config", "alpha.separator=,",
    ]);
    if (a.subcommand !== "run") throw new Error("expected run");
    expect(a.pluginConfigs).toEqual([
      { name: "alpha", key: "precision", value: 2 },
      { name: "alpha", key: "separator", value: "," },
    ]);
  });

  it("defaults pluginConfigs to an empty array when --plugin-config is absent", () => {
    const a = parseArgs(["hello"]);
    if (a.subcommand !== "run") throw new Error("expected run");
    expect(a.pluginConfigs).toEqual([]);
  });

  it("throws when --plugin-config has no value", () => {
    expect(() => parseArgs(["--plugin-config"])).toThrow(ArgvError);
  });

  it("throws on a malformed --plugin-config spec (no dot)", () => {
    expect(() => parseArgs(["--plugin-config", "nodot"])).toThrow(ArgvError);
    expect(() => parseArgs(["--plugin-config", "nodot"])).toThrow(/<name>\.<key>/);
  });

  it("throws on a malformed --plugin-config spec (dot but no equals)", () => {
    expect(() => parseArgs(["--plugin-config", "foo.noequals"])).toThrow(ArgvError);
  });

  // Phase B / Item 15.1: the runner's XOR check — both
  // flags must be passed together. Caught by `run()`,
  // not `parseArgs` (the parser accepts them
  // independently; the runner enforces the constraint).
  it("rejects --import-config without --from with a usage error", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    try {
      await run({
        argv: ["--import-config", "/tmp/codex.toml", "hello"],
        stdout: out,
        stderr: err,
        model: { async complete() { throw new Error("not called"); } },
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(64);
      expect((e as CliError).message).toMatch(/--import-config and --from/);
    }
  });

  it("rejects --from without --import-config with a usage error", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    try {
      await run({
        argv: ["--from", "codex", "hello"],
        stdout: out,
        stderr: err,
        model: { async complete() { throw new Error("not called"); } },
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(64);
      expect((e as CliError).message).toMatch(/--import-config and --from/);
    }
  });

  // Phase B / Item 15.1: end-to-end. A real codex TOML
  // gets imported and the agent's permission mode
  // reflects the imported value. We assert via the
  // import-warning stderr line (the agent itself
  // doesn't expose the ConfigLayer — but the warning
  // proves the import ran).
  it("imports a real codex config and prints ignored-key warnings", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "envoy-import-e2e-"));
    try {
      const codex = path.join(dir, "codex.toml");
      await writeFile(
        codex,
        [
          `sandbox_mode = "workspace-write"`,
          `approval_policy = "on-request"`,
          // A known-but-ignored key + an unknown one,
          // so the warning summary line has something
          // to print.
          `model = "gpt-5.1"`,
          `typo_field = 1`,
          ``,
        ].join("\n"),
        "utf8",
      );
      const out = new StringWritable();
      const err = new StringWritable();
      const fakeModel: ModelAdapter = {
        async complete(): Promise<ModelResponse> {
          return {
            content: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
          };
        },
      };
      await run({
        argv: ["--import-config", codex, "--from", "codex", "hi"],
        model: fakeModel,
        stdout: out,
        stderr: err,
      });
      // Two ignored keys → "2 codex keys not mapped".
      expect(err.data).toMatch(/2 codex keys not mapped/);
      // The agent still ran (we're not asserting on its
      // internal state — just on the import side-effect).
      expect(out.data).toContain("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseArgs: self-evolve subcommand", () => {
  it("dispatches to self-evolve when first positional is 'self-evolve'", () => {
    const a = parseArgs(["self-evolve", "--commit"]);
    if (a.subcommand !== "self-evolve") {
      throw new Error("expected self-evolve subcommand");
    }
    expect(a.commit).toBe(true);
  });

  it("captures --scoreboard, --snapshot-dir, --benchmark, --ruleset, --agents-md", () => {
    const a = parseArgs([
      "self-evolve",
      "--scoreboard", "/tmp/sb.yaml",
      "--snapshot-dir", "/tmp/snaps",
      "--benchmark", "/tmp/bench.yaml",
      "--ruleset", "/tmp/rules.json",
      "--agents-md", "/tmp/AGENTS.md",
    ]);
    if (a.subcommand !== "self-evolve") throw new Error("expected self-evolve");
    expect(a.scoreboard).toBe("/tmp/sb.yaml");
    expect(a.snapshotDir).toBe("/tmp/snaps");
    expect(a.benchmark).toBe("/tmp/bench.yaml");
    expect(a.ruleset).toBe("/tmp/rules.json");
    expect(a.agentsMd).toBe("/tmp/AGENTS.md");
  });

  it("captures --pull, --peer-id, --adoptions (F6.4)", () => {
    const a = parseArgs([
      "self-evolve",
      "--pull",
      "--peer-id", "peer-abc",
      "--adoptions", "/tmp/adoptions.yaml",
    ]);
    if (a.subcommand !== "self-evolve") throw new Error("expected self-evolve");
    expect(a.pull).toBe(true);
    expect(a.peerId).toBe("peer-abc");
    expect(a.adoptions).toBe("/tmp/adoptions.yaml");
  });

  it("rejects unknown flags in self-evolve", () => {
    expect(() => parseArgs(["self-evolve", "--bogus"])).toThrow(ArgvError);
  });
});

describe("run: usage errors", () => {
  it("--version prints the version", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    await run({ argv: ["--version"], stdout: out, stderr: err });
    expect(out.data).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help prints the help text", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    await run({ argv: ["--help"], stdout: out, stderr: err });
    expect(out.data).toContain("envoy-harness");
    expect(out.data).toContain("--sandbox");
  });

  it("throws CliError with EXIT_USAGE on unknown flag", async () => {
    try {
      await run({ argv: ["--bogus"] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(64);
    }
  });

  it("throws CliError with EXIT_USAGE when no prompt is given", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    try {
      await run({
        argv: [],
        stdout: out,
        stderr: err,
        // Even with a model, no prompt → usage error.
        model: { async complete() { throw new Error("not called"); } },
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(64);
    }
  });

  it("throws CliError when no model is configured", async () => {
    try {
      await run({ argv: ["hello"] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(64);
      // F7.5: error message points to --provider + env var.
      expect((err as CliError).message).toMatch(/--provider/);
    }
  });
});

describe("run: with a fake model", () => {
  it("runs the prompt through the agent and prints the result", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "echoed: hello" }],
          stopReason: "end_turn",
        };
      },
    };
    const result = await run({
      argv: ["echo", "hello"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    // Narrow: these tests only invoke the run subcommand.
    if (result.subcommand !== "run") throw new Error("expected run subcommand");
    expect(result.content).toBe("echoed: hello");
    expect(result.stopReason).toBe("end_turn");
    expect(out.data).toContain("echoed: hello");
  });

  it("joins multiple positional args into one prompt", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    let captured: string | undefined;
    const fakeModel: ModelAdapter = {
      async complete(input) {
        const first = input.messages[0];
        const firstBlock = first?.content[0] as Extract<ContentBlock, { type: "text" }> | undefined;
        captured = firstBlock?.text;
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
        };
      },
    };
    await run({
      argv: ["a", "b", "c"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    expect(captured).toBe("a b c");
  });

  it("respects --quiet (no stdout)", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "should-not-appear" }],
          stopReason: "end_turn",
        };
      },
    };
    const result = await run({
      argv: ["--quiet", "hi"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    if (result.subcommand !== "run") throw new Error("expected run subcommand");
    expect(result.content).toBe("should-not-appear");
    expect(out.data).toBe("");
  });

  it("--plan injects a plan-mode system prompt", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    let sawSystemPrompt = false;
    const fakeModel: ModelAdapter = {
      async complete(input): Promise<ModelResponse> {
        if (
          input.messages.some(
            (m) =>
              m.role === "system" &&
              m.content.some(
                (b) => b.type === "text" && b.text.includes("PLAN MODE"),
              ),
          )
        ) {
          sawSystemPrompt = true;
        }
        return {
          content: [{ type: "text", text: "plan" }],
          stopReason: "end_turn",
        };
      },
    };
    await run({
      argv: ["--plan", "explore", "the", "code"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    expect(sawSystemPrompt).toBe(true);
  });

  it("applies the default $5.00 cost ceiling and surfaces the abort reason", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "expensive" }],
          stopReason: "end_turn",
          model: "gpt-4o",
          usage: { inputTokens: 3_000_000, outputTokens: 0 }, // $7.50 > $5
        };
      },
    };
    const result = await run({
      argv: ["hi"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    if (result.subcommand !== "run") throw new Error("expected run");
    expect(result.stopReason).toBe("aborted");
    expect(result.content).toMatch(/\[aborted\] max-cost-usd exceeded/);
  });

  it("--verbose prints tool calls to stderr", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    let calls = 0;
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        calls++;
        return calls === 1
          ? {
              content: [
                {
                  type: "tool_call",
                  id: "t1",
                  name: "read_file",
                  args: { path: "README.md" },
                },
              ],
              stopReason: "tool_use",
            }
          : {
              content: [{ type: "text", text: "done" }],
              stopReason: "end_turn",
            };
      },
    };
    const result = await run({
      argv: ["--verbose", "go"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    if (result.subcommand !== "run") throw new Error("expected run");
    expect(err.data).toContain("[verbose] tool_call read_file");
  });
});

// ---------------------------------------------------------------------------
// F9.4: --json flag
// ---------------------------------------------------------------------------

describe("run: --json flag", () => {
  it("streams trace events to stdout as JSON Lines", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
        };
      },
    };
    await run({
      argv: ["--json", "--quiet", "hi"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    // --quiet suppresses the human-readable final text;
    // only the JSON trace events land on stdout.
    const lines = out.data.split("\n").filter((l) => l.length > 0);
    const events = lines.map((l) => JSON.parse(l) as { kind: string });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("agent_start");
    expect(kinds).toContain("agent_end");
    // agent_start must be the first event.
    expect(kinds[0]).toBe("agent_start");
    // agent_end must be the last event.
    expect(kinds[kinds.length - 1]).toBe("agent_end");
  });

  it("streams tool_call + tool_result when the model emits a tool", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    let calls = 0;
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        calls++;
        if (calls === 1) {
          return {
            content: [
              { type: "tool_call", id: "t1", name: "echo", args: { s: "x" } },
            ],
            stopReason: "tool_use",
          };
        }
        return {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
        };
      },
    };
    // The default tool registry has read_file + bash
    // but no echo tool; the agent will see the unknown
    // tool and write `isError: true` to the transcript.
    // For trace purposes, the tool_call + tool_result
    // events still fire (we test the trace, not the
    // tool's existence).
    await run({
      argv: ["--json", "--quiet", "use echo"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    const lines = out.data.split("\n").filter((l) => l.length > 0);
    const events = lines.map((l) => JSON.parse(l) as { kind: string });
    expect(events.map((e) => e.kind)).toContain("tool_call");
    expect(events.map((e) => e.kind)).toContain("tool_result");
  });

  it("does not emit trace events when --json is not set", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "hi" }],
          stopReason: "end_turn",
        };
      },
    };
    await run({
      argv: ["hi"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    // No JSON in stdout — the only line is the agent's
    // text "hi\n".
    expect(out.data).toBe("hi\n");
  });

  it("respects --quiet alongside --json (no human output, just trace)", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "should-not-appear" }],
          stopReason: "end_turn",
        };
      },
    };
    await run({
      argv: ["--json", "--quiet", "hi"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    // The text should not appear as a human line.
    const lines = out.data.split("\n").filter((l) => l.length > 0);
    // Every line should be a JSON event (parseable).
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // The last event must be agent_end (the trace
    // is complete; no "should-not-appear" follows
    // as human output).
    const lastLine = lines[lines.length - 1];
    const lastEvent = JSON.parse(lastLine!) as { kind: string };
    expect(lastEvent.kind).toBe("agent_end");
  });
});

// ---------------------------------------------------------------------------
// F9.3: team subcommand
// ---------------------------------------------------------------------------

describe("run: team subcommand", () => {
  // A tiny helper to write a temp TOML file.
  const tmpFiles: string[] = [];
  function writeToml(content: string): string {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envoy-team-"));
    const file = path.join(dir, "team.toml");
    fs.writeFileSync(file, content, "utf8");
    tmpFiles.push(file);
    return file;
  }

  it("reads a TOML file and runs the team", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    let calls = 0;
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        calls++;
        return {
          content: [{ type: "text", text: `result-${calls}` }],
          stopReason: "end_turn",
        };
      },
    };
    const toml = `
name = "t1"

[[agents]]
id = "explore"
role = "explore"
system_prompt = "sp"
objective = "do A"
depends_on = []

[[agents]]
id = "review"
role = "review"
system_prompt = "sp"
objective = "do B"
depends_on = ["explore"]
`;
    const file = writeToml(toml);
    const result = await run({
      argv: ["team", file, "--quiet"],
      model: fakeModel,
      stdout: out,
      stderr: err,
    });
    if (result.subcommand !== "team") {
      throw new Error("expected team subcommand");
    }
    expect(result.teamName).toBe("t1");
    expect(result.status).toBe("completed");
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0]?.id).toBe("explore");
    expect(result.agents[1]?.id).toBe("review");
  });

  it("throws CliError when the config path is missing", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "x" }],
          stopReason: "end_turn",
        };
      },
    };
    await expect(
      run({
        argv: ["team"],
        model: fakeModel,
        stdout: out,
        stderr: err,
      }),
    ).rejects.toThrow(/requires a TOML config path/);
  });

  it("throws CliError on a bad TOML (missing agents)", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const fakeModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "x" }],
          stopReason: "end_turn",
        };
      },
    };
    const file = writeToml('name = "t"\n');
    await expect(
      run({
        argv: ["team", file, "--quiet"],
        model: fakeModel,
        stdout: out,
        stderr: err,
      }),
    ).rejects.toThrow(/invalid team config/);
  });
});
