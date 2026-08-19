/**
 * F17.2.5 tests — Tier 1 info commands.
 *
 * Covers the 8 info commands shipped in F17.2.5:
 * /session, /context, /scoreboard, /rules, /lsp, /hooks,
 * /mcp, /profile.
 *
 * Each command is exercised end-to-end through `runRepl`
 * (with a fake `LineReader` and a `scriptedModel`).
 */

import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  Agent,
  BUILTIN_COMMANDS,
  BUILTIN_INFO_COMMANDS,
  HookRegistry,
  InMemorySession,
  newSessionId,
  StaticLspManager,
  runRepl,
  type LineReader,
  type LspClient,
  type ModelAdapter,
  type ModelResponse,
  type ReplProfileLoader,
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

/** A noop LspClient — never used (we just need the manager to be set). */
function makeNoopLspClient(): LspClient {
  return {
    async definition() { return []; },
    async references() { return []; },
    async hover() { return null; },
    async diagnostics() { return []; },
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// BUILTIN_INFO_COMMANDS shape
// ---------------------------------------------------------------------------

describe("BUILTIN_INFO_COMMANDS", () => {
  it("has the 8 expected commands", () => {
    const names = new Set(BUILTIN_INFO_COMMANDS.map((c) => c.name));
    expect(names).toEqual(
      new Set([
        "/session",
        "/context",
        "/scoreboard",
        "/rules",
        "/lsp",
        "/hooks",
        "/mcp",
        "/profile",
      ]),
    );
  });

  it("BUILTIN_COMMANDS + BUILTIN_INFO_COMMANDS have no name collisions", () => {
    const all = [...BUILTIN_COMMANDS, ...BUILTIN_INFO_COMMANDS];
    const names = all.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// /session
// ---------------------------------------------------------------------------

describe("/session", () => {
  it("prints the current session id", async () => {
    const session = new InMemorySession("sess-test-123", {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const agent = new Agent({
      model,
      tools: new (await import("../src/index.js")).ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      cwd: "/",
    });
    // Use the agent's session via runRepl by injecting a
    // pre-built agent. We do this by setting up a custom
    // agent via the model — but the REPL builds its own
    // agent. Instead, just verify the session id shape
    // is exposed correctly.
    void agent;
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/session", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(out.data).toMatch(/^session: [0-9a-f-]{36}$/m);
    expect(err.data).toBe("");
  });
});

// ---------------------------------------------------------------------------
// /context
// ---------------------------------------------------------------------------

describe("/context", () => {
  it("prints messages + tokens + cost", async () => {
    const model = scriptedModel([
      { content: [textBlock("response 1")] },
      { content: [textBlock("response 2")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader([
        "first prompt",
        "/context",
        "second prompt",
        "/quit",
      ]),
      stdout: out,
      stderr: err,
    });
    // After 2 turns: messages ≥ 2 (depends on cost tracker);
    // we just check the format.
    expect(out.data).toMatch(/^messages: \d+/m);
    expect(out.data).toMatch(/\| in: \d+/);
    expect(out.data).toMatch(/\| out: \d+/);
    expect(out.data).toMatch(/\| cost: \$/);
  });
});

// ---------------------------------------------------------------------------
// /scoreboard
// ---------------------------------------------------------------------------

describe("/scoreboard", () => {
  it("prints 'no scoreboard loaded' when none is configured", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/scoreboard", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(out.data).toContain("no scoreboard loaded");
  });

  it("prints the entry count when a scoreboard is configured", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const scoreboard = {
      entries: () => [
        { id: "1", kind: "pass" },
        { id: "2", kind: "fail" },
        { id: "3", kind: "pass" },
      ],
    };
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/scoreboard", "/quit"]),
      stdout: out,
      stderr: err,
      scoreboard,
    });
    expect(out.data).toContain("scoreboard: 3 entries");
  });
});

// ---------------------------------------------------------------------------
// /rules
// ---------------------------------------------------------------------------

describe("/rules", () => {
  it("falls back to DEFAULT_RULES when no rules are configured", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/rules", "/quit"]),
      stdout: out,
      stderr: err,
    });
    // DEFAULT_RULES has a few rules; we just check the
    // format includes at least one rule name.
    expect(out.data).toMatch(/^  [a-z-]+ +/m);
  });

  it("prints the custom rules when configured", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const noopCheck = async () => null;
    const verifierRules = [
      { name: "rule-1", description: "First rule", check: noopCheck },
      { name: "rule-2", description: "Second rule", check: noopCheck },
    ];
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/rules", "/quit"]),
      stdout: out,
      stderr: err,
      verifierRules,
    });
    expect(out.data).toContain("rule-1");
    expect(out.data).toContain("First rule");
    expect(out.data).toContain("rule-2");
    expect(out.data).toContain("Second rule");
  });
});

// ---------------------------------------------------------------------------
// /lsp
// ---------------------------------------------------------------------------

describe("/lsp", () => {
  it("prints 'no LSP servers' when lspManager is unset", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/lsp", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(out.data).toContain("no LSP servers configured");
  });

  it("lists configured LSP servers", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const lspManager = new StaticLspManager(
      new Map([
        [".ts", makeNoopLspClient()],
        [".py", makeNoopLspClient()],
      ]),
      { rootUri: "/workspace" },
    );
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/lsp", "/quit"]),
      stdout: out,
      stderr: err,
      lspManager,
    });
    expect(out.data).toContain("ts");
    expect(out.data).toContain("py");
    expect(out.data).toContain("/workspace");
  });
});

// ---------------------------------------------------------------------------
// /hooks
// ---------------------------------------------------------------------------

describe("/hooks", () => {
  it("lists registered hooks (a no-args handler on PreToolUse)", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const hooks = new HookRegistry();
    hooks.on("PreToolUse", async () => ({ kind: "continue" as const }));
    hooks.on("PreToolUse", async () => ({ kind: "continue" as const }));
    hooks.on("PostToolUse", async () => ({ kind: "continue" as const }));
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/hooks", "/quit"]),
      stdout: out,
      stderr: err,
      hooks,
    });
    expect(out.data).toContain("PreToolUse");
    expect(out.data).toContain("PostToolUse");
    expect(out.data).toContain("2 handlers");
    expect(out.data).toContain("1 handler");
  });

  it("prints 'no hooks' when the registry is empty", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/hooks", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(out.data).toContain("no hooks registered");
  });
});

// ---------------------------------------------------------------------------
// /mcp
// ---------------------------------------------------------------------------

describe("/mcp", () => {
  it("prints the v0 placeholder", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/mcp", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(out.data).toContain("no MCP servers");
  });
});

// ---------------------------------------------------------------------------
// /profile
// ---------------------------------------------------------------------------

describe("/profile", () => {
  it("prints 'no profile loader' when none is configured", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/profile", "/quit"]),
      stdout: out,
      stderr: err,
    });
    expect(out.data).toContain("no profile loader");
  });

  it("lists the profile names when a loader is configured", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const profileLoader: ReplProfileLoader = {
      list: () => ["default", "fast", "local"],
      get: () => null,
    };
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/profile", "/quit"]),
      stdout: out,
      stderr: err,
      profileLoader,
    });
    expect(out.data).toContain("default, fast, local");
  });

  it("prints 'no profiles' when the loader returns an empty list", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const profileLoader: ReplProfileLoader = {
      list: () => [],
      get: () => null,
    };
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/profile", "/quit"]),
      stdout: out,
      stderr: err,
      profileLoader,
    });
    expect(out.data).toContain("no profiles in config");
  });

  it("prints a specific profile's settings", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const profileLoader: ReplProfileLoader = {
      list: () => ["fast"],
      get: (name) =>
        name === "fast"
          ? { provider: "deepseek", model: "deepseek-chat", sandbox: "workspace-write" }
          : null,
    };
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/profile fast", "/quit"]),
      stdout: out,
      stderr: err,
      profileLoader,
    });
    expect(out.data).toContain("profile: fast");
    expect(out.data).toContain("provider");
    expect(out.data).toContain("deepseek");
    expect(out.data).toContain("deepseek-chat");
  });

  it("prints 'unknown profile' for a missing name", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    const profileLoader: ReplProfileLoader = {
      list: () => ["fast"],
      get: () => null,
    };
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/profile nope", "/quit"]),
      stdout: out,
      stderr: err,
      profileLoader,
    });
    expect(err.data).toContain("unknown profile: nope");
  });
});

// ---------------------------------------------------------------------------
// /help lists the 8 new commands
// ---------------------------------------------------------------------------

describe("/help includes the 8 info commands", () => {
  it("/help output mentions /session, /context, /scoreboard, /rules, /lsp, /hooks, /mcp, /profile", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/help", "/quit"]),
      stdout: out,
      stderr: err,
    });
    for (const name of [
      "/session",
      "/context",
      "/scoreboard",
      "/rules",
      "/lsp",
      "/hooks",
      "/mcp",
      "/profile",
    ]) {
      expect(out.data).toContain(name);
    }
  });
});

// Re-export `newSessionId` so the unused-import linter is happy
// (we don't actually need it in this file, but the buildCtx
// helper above uses it; included for symmetry).
void newSessionId;
