/**
 * F17.2 tests — slash command registry.
 *
 * Covers:
 * 1. parseCommandLine tokenizes correctly (with + without args).
 * 2. parseCommandLine returns null for non-slash input.
 * 3. parseCommandLine returns empty name for `/` alone.
 * 4. ReplCommandRegistry lookup + listVisible.
 * 5. dispatchCommand returns "exit" for /quit + /exit.
 * 6. dispatchCommand returns "unknown" for unregistered names.
 * 7. dispatchCommand catches handler errors → "error".
 * 8. /help lists all visible built-in commands.
 * 9. /sandbox updates the agent's policy + the args.
 * 10. /sandbox rejects invalid modes.
 * 11. /clear resets the session.
 * 12. /cost prints cost + turns.
 * 13. /status prints sandbox + approval + turns + cost.
 * 14. Custom commands (via ReplOptions.customCommands) are
 *     invoked; built-ins win on name collision.
 * 15. End-to-end via runRepl: a slash command's output goes
 *     to the right stream.
 */

import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  BUILTIN_COMMANDS,
  ReplCommandRegistry,
  dispatchCommand,
  parseCommandLine,
  runRepl,
  type LineReader,
  type ModelAdapter,
  type ModelResponse,
  type ReplCommand,
  type ReplContext,
  type RunParsedArgs,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

function scriptedModel(responses: ReadonlyArray<{
  content: ModelResponse["content"];
  stopReason?: ModelResponse["stopReason"];
}>): ModelAdapter & { callCount: () => number } {
  let i = 0;
  const adapter: ModelAdapter & { callCount: () => number } = {
    async complete() {
      const r = responses[i++];
      if (!r) throw new Error(`scriptedModel: exhausted (call #${i})`);
      return {
        content: r.content,
        stopReason: r.stopReason ?? (r.content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn"),
      };
    },
    callCount: () => i,
  };
  return adapter;
}

function textBlock(text: string): ModelResponse["content"][number] {
  return { type: "text", text };
}

function fakeLineReader(lines: ReadonlyArray<string>): LineReader {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<string>> {
      if (i >= lines.length) {
        return { value: undefined as unknown as string, done: true };
      }
      const value = lines[i++];
      if (value === undefined) {
        return { value: undefined as unknown as string, done: true };
      }
      return { value, done: false };
    },
    close() {
      // no-op for the fake
    },
  };
}

function makeArgs(overrides: Partial<RunParsedArgs> = {}): RunParsedArgs {
  return {
    subcommand: "run",
    help: false,
    version: false,
    json: false,
    sandbox: undefined,
    approval: undefined,
    model: undefined,
    provider: undefined,
    cwd: undefined,
    maxTurns: undefined,
    maxCostUsd: undefined,
    resume: undefined,
    fork: undefined,
    plan: false,
    repl: false,
    noColor: false,
    verbose: false,
    quiet: false,
    positional: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1-3. parseCommandLine
// ---------------------------------------------------------------------------

describe("parseCommandLine", () => {
  it("tokenizes /help", () => {
    expect(parseCommandLine("/help")).toEqual({ name: "/help", args: [] });
  });

  it("tokenizes /model with args", () => {
    expect(parseCommandLine("/model gpt-4o")).toEqual({
      name: "/model",
      args: ["gpt-4o"],
    });
  });

  it("tokenizes /sandbox with a mode", () => {
    expect(parseCommandLine("/sandbox workspace-write")).toEqual({
      name: "/sandbox",
      args: ["workspace-write"],
    });
  });

  it("collapses extra whitespace", () => {
    expect(parseCommandLine("/model    gpt-4o   ")).toEqual({
      name: "/model",
      args: ["gpt-4o"],
    });
  });

  it("returns null for non-slash input", () => {
    expect(parseCommandLine("hello world")).toBeNull();
  });

  it("returns empty name for a lone `/`", () => {
    expect(parseCommandLine("/")).toEqual({ name: "", args: [] });
  });

  it("returns empty name for whitespace after `/`", () => {
    expect(parseCommandLine("/   ")).toEqual({ name: "", args: [] });
  });
});

// ---------------------------------------------------------------------------
// 4. ReplCommandRegistry
// ---------------------------------------------------------------------------

describe("ReplCommandRegistry", () => {
  it("registers and looks up a command by name", () => {
    const reg = new ReplCommandRegistry();
    const cmd: ReplCommand = { name: "/test", description: "test", handler: () => {} };
    reg.register(cmd);
    expect(reg.lookup("/test")).toBe(cmd);
  });

  it("listVisible returns non-hidden commands sorted by name", () => {
    const reg = new ReplCommandRegistry();
    reg.registerAll([
      { name: "/zebra", description: "z", handler: () => {} },
      { name: "/alpha", description: "a", handler: () => {} },
      { name: "/hidden", description: "h", hidden: true, handler: () => {} },
    ]);
    const visible = reg.listVisible();
    expect(visible.map((c) => c.name)).toEqual(["/alpha", "/zebra"]);
  });

  it("BUILTIN_COMMANDS has the 9 expected commands", () => {
    const names = new Set(BUILTIN_COMMANDS.map((c) => c.name));
    expect(names).toEqual(
      new Set([
        "/help",
        "/model",
        "/provider",
        "/sandbox",
        "/approval",
        "/clear",
        "/cost",
        "/status",
        "/quit",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// 5-7. dispatchCommand
// ---------------------------------------------------------------------------

describe("dispatchCommand", () => {
  function buildCtx(): ReplContext {
    const out = new StringWritable();
    const err = new StringWritable();
    return {
      agent: {} as never, // tests use synthetic commands
      args: makeArgs(),
      stdout: out,
      stderr: err,
      turns: 0,
      totalCostUsd: 0,
      registry: new ReplCommandRegistry(),
    };
  }

  it("returns 'exit' for /quit", async () => {
    const reg = new ReplCommandRegistry();
    const result = await dispatchCommand(reg, "/quit", [], buildCtx());
    expect(result.kind).toBe("exit");
  });

  it("returns 'exit' for /exit (alias)", async () => {
    const reg = new ReplCommandRegistry();
    const result = await dispatchCommand(reg, "/exit", [], buildCtx());
    expect(result.kind).toBe("exit");
  });

  it("returns 'unknown' for an unregistered name", async () => {
    const reg = new ReplCommandRegistry();
    const result = await dispatchCommand(reg, "/bogus", [], buildCtx());
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") expect(result.name).toBe("/bogus");
  });

  it("returns 'error' when the handler throws", async () => {
    const reg = new ReplCommandRegistry();
    reg.register({
      name: "/boom",
      description: "always throws",
      handler: () => {
        throw new Error("kaboom");
      },
    });
    const result = await dispatchCommand(reg, "/boom", [], buildCtx());
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toBe("kaboom");
  });

  it("returns 'ok' for a registered command that doesn't throw", async () => {
    const reg = new ReplCommandRegistry();
    reg.register({ name: "/ok", description: "ok", handler: () => {} });
    const result = await dispatchCommand(reg, "/ok", [], buildCtx());
    expect(result.kind).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 8-13. Built-in command handlers (end-to-end through runRepl)
// ---------------------------------------------------------------------------

describe("built-in commands via runRepl", () => {
  it("/help lists all visible built-in commands", async () => {
    const model = scriptedModel([{ content: [textBlock("never called")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/help", "/quit"]),
      stdout: out,
      stderr: err,
    });
    // The output contains the 9 visible built-in commands.
    for (const name of [
      "/help",
      "/model",
      "/provider",
      "/sandbox",
      "/approval",
      "/clear",
      "/cost",
      "/status",
      "/quit",
    ]) {
      expect(out.data).toContain(name);
    }
    expect(err.data).toBe("");
  });

  it("/sandbox updates the agent's policy + args.sandbox", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const args = makeArgs();
    await runRepl({
      model,
      args,
      lineReader: fakeLineReader(["/sandbox workspace-write", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(args.sandbox).toBe("workspace-write");
    expect(out.data).toContain("sandbox: workspace-write");
  });

  it("/sandbox rejects an invalid mode", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const args = makeArgs();
    await runRepl({
      model,
      args,
      lineReader: fakeLineReader(["/sandbox bogus", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(args.sandbox).toBeUndefined();
    expect(err.data).toContain("error:");
    expect(err.data).toContain("bogus");
  });

  it("/clear resets the session transcript", async () => {
    const model = scriptedModel([
      { content: [textBlock("response 1")] },
      { content: [textBlock("response 2")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["first prompt", "/clear", "second prompt", "/quit"]),
      stdout: out,
      stderr: err,
    });
    // After /clear, the model is called twice (once per turn),
    // and both responses appear in the output.
    expect(model.callCount()).toBe(2);
    expect(out.data).toContain("response 1");
    expect(out.data).toContain("response 2");
    expect(out.data).toContain("session cleared");
  });

  it("/cost prints cost + turns", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["hello", "/cost", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(out.data).toMatch(/cost: \$/);
    expect(out.data).toMatch(/turns: 1/);
  });

  it("/status prints sandbox + approval + turns + cost + cwd", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs({ sandbox: "workspace-write", approval: "on-request" }),
      lineReader: fakeLineReader(["/status", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(out.data).toContain("sandbox:   workspace-write");
    expect(out.data).toContain("approval:  on-request");
    expect(out.data).toContain("turns:     0");
    expect(out.data).toMatch(/cost:      \$/);
    expect(out.data).toMatch(/cwd:       /);
  });

  it("unknown /command prints 'unknown command' + /help hint", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/bogus", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(err.data).toContain("unknown command: /bogus");
    expect(err.data).toContain("/help");
  });
});

// ---------------------------------------------------------------------------
// 14. customCommands
// ---------------------------------------------------------------------------

describe("custom slash commands", () => {
  it("a custom command is invoked when the user types its name", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const custom: ReplCommand = {
      name: "/pr",
      description: "open a PR",
      handler(_args, ctx) {
        ctx.stdout.write("opening a PR\n");
      },
    };
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/pr", "/quit"]),
      stdout: out,
      stderr: err,
      customCommands: [custom],
    });
    expect(out.data).toContain("opening a PR");
  });

  it("a built-in wins on name collision (custom /help is shadowed)", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const custom: ReplCommand = {
      name: "/help",
      description: "the host's help (shadowed)",
      handler(_args, ctx) {
        ctx.stdout.write("CUSTOM HELP\n");
      },
    };
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/help", "/quit"]),
      stdout: out,
      stderr: err,
      customCommands: [custom],
    });
    // The built-in /help lists all 9 commands; the custom
    // /help is shadowed and never runs.
    expect(out.data).not.toContain("CUSTOM HELP");
    expect(out.data).toContain("/quit");
  });

  it("a handler that throws prints 'error: <message>' to stderr", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const custom: ReplCommand = {
      name: "/explode",
      description: "always throws",
      handler() {
        throw new Error("boom");
      },
    };
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/explode", "/quit"]),
      stdout: out,
      stderr: err,
      customCommands: [custom],
    });
    expect(err.data).toContain("error: boom");
  });
});
