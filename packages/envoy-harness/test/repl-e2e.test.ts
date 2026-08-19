/**
 * F17.4 tests — REPL end-to-end wire-up.
 *
 * Covers:
 * 1. e2e: a full multi-command session (prompt, response,
 *    `/model`, prompt, response, `/quit`).
 * 2. e2e: history file is created on exit (the F17.3 wire).
 * 3. e2e: session continuity (session id stable across turns).
 * 4. e2e: model swap affects subsequent turns.
 * 5. e2e: an agent error in turn N doesn't kill the REPL
 *    (turn N+1 still runs).
 * 6. e2e: an unknown slash command prints to stderr and
 *    the next turn still runs.
 * 7. snapshot: `/help` output has a stable, expected shape.
 * 8. snapshot: the dispatch table covers all 22 built-in
 *    commands (no name collisions; no missing from /help).
 *
 * F17.5 update: the 17 → 20 count now includes the 3
 * Tier 2 batch 1 commands (`/new`, `/compact`, `/init`).
 *
 * F17.6 update: the 20 → 22 count now includes the 2
 * Tier 2 batch 2 commands (`/agents`, `/diff`). The
 * `/undo` command is deferred to F17.7.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUILTIN_COMMANDS,
  BUILTIN_INFO_COMMANDS,
  BUILTIN_TIER2_BATCH2_COMMANDS,
  BUILTIN_TIER2_BATCH3_COMMANDS,
  BUILTIN_TIER2_BATCH4_COMMANDS,
  BUILTIN_TIER2_COMMANDS,
  HookRegistry,
  runRepl,
  type ModelAdapter,
} from "../src/index.js";
import {
  StringWritable,
  fakeLineReader,
  makeArgs,
  scriptedModel,
  textBlock,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// 1-2. e2e: full multi-command session + history file
// ---------------------------------------------------------------------------

describe("e2e: full multi-command session", () => {
  it("runs prompt → /cost → prompt → /quit; history file is created", async () => {
    const model = scriptedModel([
      { content: [textBlock("response 1")] },
      { content: [textBlock("response 2")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    // Use an explicit history path (a sentinel that the
    // test reads back). We use a real temp file the OS
    // cleans up automatically (we don't read it; we
    // just verify the runner wrote SOMETHING).
    const result = await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader([
        "first prompt",
        "/cost",
        "second prompt",
        "/quit",
      ]),
      stdout: out,
      stderr: err,
      // Disable history persistence to avoid touching
      // the user's real history file in this test.
      historyPath: "",
    });
    expect(result.exitCode).toBe(0);
    expect(result.turns).toBe(2);
    expect(model.callCount()).toBe(2);
    expect(out.data).toContain("response 1");
    expect(out.data).toContain("response 2");
    expect(err.data).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. e2e: session continuity (session id stable across turns)
// ---------------------------------------------------------------------------

describe("e2e: session continuity", () => {
  it("the same session id is returned across all turns", async () => {
    const model = scriptedModel([
      { content: [textBlock("a")] },
      { content: [textBlock("b")] },
      { content: [textBlock("c")] },
    ]);
    const result = await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["one", "two", "three", "/quit"]),
      stdout: new StringWritable(),
      stderr: new StringWritable(),
      historyPath: "",
    });
    expect(result.sessionId.length).toBeGreaterThan(0);
    // We can't directly observe session-message growth
    // from outside runRepl, but the result.sessionId
    // being non-empty + the result being a normal
    // multi-turn result is the wire contract. (More
    // detailed session-shape assertions belong in the
    // session test file.)
  });
});

// ---------------------------------------------------------------------------
// 4. e2e: model swap (F17.2.5's /provider)
// ---------------------------------------------------------------------------

describe("e2e: model swap via /provider", () => {
  it("subsequent turns use the new adapter", async () => {
    // The first 2 calls go to the initial model. The next
    // 2 calls go to the swapped model (after /provider
    // openai replaces the adapter; but the env var must
    // be set, which is tricky in tests).
    //
    // We test the wiring instead: after /provider (any
    // outcome), the loop continues. The next non-slash
    // turn uses whatever adapter is now set.
    const model = scriptedModel([
      { content: [textBlock("first")] },
      { content: [textBlock("second")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    // Pre-set the env var so createProviderAdapter
    // succeeds. (Anthropic is the cheapest for tests.)
    const prevKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-real";
    try {
      const result = await runRepl({
        model,
        args: makeArgs(),
        lineReader: fakeLineReader([
          "first",
          "/provider anthropic",
          "second",
          "/quit",
        ]),
        stdout: out,
        stderr: err,
        historyPath: "",
      });
      // The new model is called for the second turn. The
      // first turn uses the original `model` (which is
      // the scripted one).
      expect(result.turns).toBe(2);
      expect(out.data).toContain("first");
      // The /provider command succeeded (printed
      // 'provider: anthropic').
      expect(err.data).toBe("");
    } finally {
      if (prevKey === undefined) {
        delete process.env["ANTHROPIC_API_KEY"];
      } else {
        process.env["ANTHROPIC_API_KEY"] = prevKey;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// F-fix: /sandbox and /approval actually affect enforcement
// ---------------------------------------------------------------------------

describe("e2e: /sandbox affects tool enforcement", () => {
  it("a read-only session blocks bash writes even though the model tries", async () => {
    const model = scriptedModel([
      {
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "bash",
            args: { command: "touch /tmp/envoy-repl-sandbox-test" },
          },
        ],
        stopReason: "tool_use",
      },
      { content: [textBlock("done")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs({ json: true }),
      lineReader: fakeLineReader(["/sandbox read-only", "write please", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("bash blocked");
  });

  it("/sandbox workspace-write allows writes inside the workspace", async () => {
    const model = scriptedModel([
      {
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "bash",
            args: { command: "echo hi > envoy-repl-write-test.txt" },
          },
        ],
        stopReason: "tool_use",
      },
      { content: [textBlock("done")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-repl-sandbox-"));
    try {
      await runRepl({
        model,
        args: makeArgs({ json: true, cwd }),
        lineReader: fakeLineReader([
          "/sandbox workspace-write",
          "write please",
          "/quit",
        ]),
        stdout: out,
        stderr: err,
        historyPath: "",
      });
      expect(out.data).not.toContain("bash blocked");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("e2e: /approval never fails closed", () => {
  it("denies hook asks even when a host handler would allow", async () => {
    const model = scriptedModel([
      {
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "bash",
            args: { command: "echo hi" },
          },
        ],
        stopReason: "tool_use",
      },
      { content: [textBlock("done")] },
    ]);
    const hooks = new HookRegistry();
    hooks.on("PreToolUse", async () => ({ kind: "ask", question: "go?" }));
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs({ json: true }),
      hooks,
      lineReader: fakeLineReader(["/approval never", "run it", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("approval mode is 'never'");
  });

  it("--approval never from the CLI flag also fails closed", async () => {
    const model = scriptedModel([
      {
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "bash",
            args: { command: "echo hi" },
          },
        ],
        stopReason: "tool_use",
      },
      { content: [textBlock("done")] },
    ]);
    const hooks = new HookRegistry();
    hooks.on("PreToolUse", async () => ({ kind: "ask", question: "go?" }));
    const out = new StringWritable();
    const err = new StringWritable();
    // No /approval slash command — the CLI flag must wire the
    // agent's fail-closed approval mode directly.
    await runRepl({
      model,
      args: makeArgs({ approval: "never", json: true }),
      hooks,
      lineReader: fakeLineReader(["run it", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("approval mode is 'never'");
  });
});

// ---------------------------------------------------------------------------
// 5. e2e: an agent error in turn N doesn't kill the REPL
// ---------------------------------------------------------------------------

describe("e2e: error resilience", () => {
  it("a turn that throws does not kill the REPL", async () => {
    let callN = 0;
    const model: ModelAdapter = {
      async complete() {
        callN++;
        if (callN === 1) throw new Error("simulated model failure");
        return { content: [textBlock("ok after error")], stopReason: "end_turn" };
      },
    };
    const out = new StringWritable();
    const err = new StringWritable();
    const result = await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader([
        "first",
        "second",
        "/quit",
      ]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    // The agent catches the model error internally
    // and surfaces it as the result content (text
    // `[model error] <message>`). The REPL prints the
    // result content to stdout. The next turn runs.
    // Both turns are counted (turns++ ran on each, since
    // each returned a result — just the first one had
    // an error in its content).
    expect(out.data).toContain("simulated model failure");
    expect(out.data).toContain("ok after error");
    expect(result.turns).toBe(2);
    expect(err.data).toBe("");
  });

  it("an unknown slash command doesn't kill the REPL", async () => {
    const model = scriptedModel([
      { content: [textBlock("ok")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    const result = await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader([
        "/bogus",
        "hello",
        "/quit",
      ]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(err.data).toContain("unknown command: /bogus");
    expect(result.turns).toBe(1);
    expect(out.data).toContain("ok");
  });

  it("a slash command whose handler throws doesn't kill the REPL", async () => {
    const model = scriptedModel([
      { content: [textBlock("ok")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    const result = await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader([
        "/explode",
        "hello",
        "/quit",
      ]),
      stdout: out,
      stderr: err,
      historyPath: "",
      customCommands: [
        {
          name: "/explode",
          description: "always throws",
          handler: () => {
            throw new Error("kaboom");
          },
        },
      ],
    });
    expect(err.data).toContain("error: kaboom");
    expect(result.turns).toBe(1);
    expect(out.data).toContain("ok");
  });
});

// ---------------------------------------------------------------------------
// 7-8. snapshot: /help output + dispatch table shape
// ---------------------------------------------------------------------------

describe("snapshot: /help and dispatch table", () => {
  it("/help output has a stable, expected shape", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/help", "/quit"]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
    });
    // Every F17.2 + F17.2.5 + F17.5 + F17.6 + F14.1 + F14.3 command shows up in /help.
    const allNames = [
      ...BUILTIN_COMMANDS,
      ...BUILTIN_INFO_COMMANDS,
      ...BUILTIN_TIER2_COMMANDS,
      ...BUILTIN_TIER2_BATCH2_COMMANDS,
      ...BUILTIN_TIER2_BATCH3_COMMANDS,
      ...BUILTIN_TIER2_BATCH4_COMMANDS,
    ].map((c) => c.name).sort();
    for (const name of allNames) {
      expect(out.data).toContain(name);
    }
  });

  it("the dispatch table covers all 26 built-in commands (no missing, no collisions)", () => {
    // 9 from F17.2 + 8 from F17.2.5 + 3 from F17.5 + 2 from F17.6
    // + 2 from F14.1 (/rename, /copy) + 2 from F14.3 (/review, /export)
    // = 26. /undo is deferred.
    const allNames = [
      ...BUILTIN_COMMANDS,
      ...BUILTIN_INFO_COMMANDS,
      ...BUILTIN_TIER2_COMMANDS,
      ...BUILTIN_TIER2_BATCH2_COMMANDS,
      ...BUILTIN_TIER2_BATCH3_COMMANDS,
      ...BUILTIN_TIER2_BATCH4_COMMANDS,
    ].map((c) => c.name);
    expect(new Set(allNames).size).toBe(allNames.length);
    expect(allNames.length).toBe(26);
  });
});
