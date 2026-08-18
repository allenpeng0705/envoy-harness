/**
 * CLI tests.
 *
 * Covers argv parsing (the parser is the part most likely to
 * silently break on a new flag) and the runner (with a fake
 * model — production adapters are a separate concern).
 */

import { Writable } from "node:stream";

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

/** A writable that records everything written to it. */
class StringWritable extends Writable {
  data = "";
  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void,
  ): void {
    this.data += chunk.toString();
    cb();
  }
}

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

  it("throws when a valued flag has no value", () => {
    expect(() => parseArgs(["--sandbox"])).toThrow(ArgvError);
    expect(() => parseArgs(["--model"])).toThrow(ArgvError);
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
      expect((err as CliError).message).toMatch(/model adapter/);
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
});
