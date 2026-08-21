/**
 * F17.5 tests — Tier 2 batch 1 commands.
 *
 * Covers the 3 commands shipped in F17.5:
 * /new, /compact, /init.
 *
 * Each command is exercised end-to-end through `runRepl`
 * (with a fake `LineReader` and a `scriptedModel`).
 *
 * Test plan (7 tests):
 * 1. BUILTIN_TIER2_COMMANDS has the 3 expected names.
 * 2. /new — starts a fresh session (new id, empty transcript).
 * 3. /compact — drops oldest messages, keeps the last N.
 * 4. /compact <keep> — honors a custom keep count.
 * 5. /compact abc — error on non-numeric keep.
 * 6. /init — writes AGENTS.md to the cwd via the model.
 * 7. /init error — model throws → command prints to stderr, REPL continues.
 * 8. dispatch table covers all 20 built-in commands.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_COMMANDS,
  BUILTIN_INFO_COMMANDS,
  BUILTIN_TIER2_COMMANDS,
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
// Per-test setup: fresh temp cwd for /init tests
// ---------------------------------------------------------------------------

let tempCwd: string;
let tempAgentsMd: string;

beforeEach(async () => {
  tempCwd = await fs.mkdtemp(
    path.join(os.tmpdir(), `envoy-harness-f17-5-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  );
  tempAgentsMd = path.join(tempCwd, "AGENTS.md");
});

afterEach(async () => {
  // Best-effort cleanup.
  try {
    await fs.unlink(tempAgentsMd);
  } catch {
    // file may not exist
  }
  try {
    await fs.rmdir(tempCwd, { recursive: true });
  } catch {
    // dir may not exist
  }
});

// ---------------------------------------------------------------------------
// 1. BUILTIN_TIER2_COMMANDS shape
// ---------------------------------------------------------------------------

describe("BUILTIN_TIER2_COMMANDS", () => {
  it("has the 3 expected commands", () => {
    const names = new Set(BUILTIN_TIER2_COMMANDS.map((c) => c.name));
    expect(names).toEqual(new Set(["/new", "/compact", "/init"]));
  });

  it("BUILTIN_COMMANDS + BUILTIN_INFO_COMMANDS + BUILTIN_TIER2_COMMANDS have no name collisions", () => {
    const all = [
      ...BUILTIN_COMMANDS,
      ...BUILTIN_INFO_COMMANDS,
      ...BUILTIN_TIER2_COMMANDS,
    ];
    const names = all.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// 2. /new — start a fresh session
// ---------------------------------------------------------------------------

describe("/new", () => {
  it("starts a fresh session (new id, empty transcript)", async () => {
    const model = scriptedModel([
      { content: [textBlock("response 1")] },
      { content: [textBlock("response 2")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    const result = await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader([
        "first prompt",
        "/session",
        "/new",
        "/session",
        "second prompt",
        "/quit",
      ]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    // Two model calls (one per non-slash turn).
    expect(model.callCount()).toBe(2);
    expect(result.turns).toBe(2);
    // The session id from the FINAL /session call should be
    // reflected in the result (the result is the LAST session
    // id, not the original; this is the post-/new session).
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // The /session output appears twice. After /new, the id
    // changes. We can detect this by capturing the two
    // session ids and asserting they differ.
    const ids = [...out.data.matchAll(/^session: ([0-9a-f-]{36})$/gm)].map(
      (m) => m[1],
    );
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(err.data).toBe("");
  });

  it("the fresh session has zero messages (verified via /context)", async () => {
    const model = scriptedModel([
      { content: [textBlock("response 1")] },
    ]);
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader([
        "first prompt",
        "/new",
        "/context",
        "/quit",
      ]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
    });
    // After /new, the /context output should show 0 messages.
    // Find the LAST "messages: N" line (the one after /new).
    const matches = [...out.data.matchAll(/^messages: (\d+)/gm)].map((m) =>
      Number(m[1]),
    );
    expect(matches.length).toBeGreaterThan(0);
    const lastMessages = matches[matches.length - 1];
    expect(lastMessages).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3-5. /compact — drop oldest messages
// ---------------------------------------------------------------------------

describe("/compact", () => {
  it("drops oldest messages and keeps the last 20 by default", async () => {
    // We need a transcript with > 20 messages. Each
    // scripted turn appends user + assistant. After N
    // turns, the session has 2N messages (plus any system
    // prompt). 12 turns = 24 messages; /compact should
    // drop the first 4, keeping 20.
    const responses = Array.from({ length: 12 }, (_, i) => ({
      content: [textBlock(`response ${i + 1}`)],
    }));
    const model = scriptedModel(responses);
    const out = new StringWritable();
    const err = new StringWritable();
    const result = await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader([
        ...Array.from({ length: 12 }, (_, i) => `prompt ${i + 1}`),
        "/context",
        "/compact",
        "/quit",
      ]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(result.turns).toBe(12);
    // The /context call happens before /compact. Find the
    // messages count, then verify /compact reports a
    // drop to 20.
    expect(out.data).toMatch(/^messages: 24\b/m);
    expect(out.data).toMatch(/^compacted: 24 → 20 messages \(kept last 20\)$/m);
    expect(err.data).toBe("");
  });

  it("honors a custom <keep> arg", async () => {
    // 6 turns = 12 messages. /compact 3 should keep the
    // last 3.
    const responses = Array.from({ length: 6 }, (_, i) => ({
      content: [textBlock(`r${i + 1}`)],
    }));
    const model = scriptedModel(responses);
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader([
        ...Array.from({ length: 6 }, (_, i) => `p${i + 1}`),
        "/compact 3",
        "/quit",
      ]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
    });
    expect(out.data).toMatch(/^compacted: 12 → 3 messages \(kept last 3\)$/m);
  });

  it("rejects a non-numeric <keep> arg", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["prompt", "/compact abc", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(err.data).toContain("error: invalid keep count: abc");
    // The command prints nothing to stdout on error.
    expect(out.data).not.toMatch(/^compacted:/m);
  });

  it("/compact --summarize runs a one-shot summarizer and injects a summary block", async () => {
    let summarySeenByTurn = false;
    let calls = 0;
    const model: ModelAdapter = {
      async complete(input) {
        calls++;
        // The second call (the post-compact turn) should see the
        // injected summary block in its context.
        const hasSummary = input.messages.some((m) =>
          m.content.some(
            (b) =>
              b.type === "text" &&
              b.text.includes("Summarized: auth refactor"),
          ),
        );
        if (hasSummary) summarySeenByTurn = true;
        return {
          content: [
            {
              type: "text",
              text:
                calls === 1
                  ? "Summarized: auth refactor"
                  : "ok",
            },
          ],
          stopReason: "end_turn",
        };
      },
    };
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs({ cwd: tempCwd }),
      lineReader: fakeLineReader([
        "first turn",
        "/compact --summarize 1",
        "second turn",
        "/quit",
      ]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(err.data).toBe("");
    expect(out.data).toContain("with summary");
    expect(summarySeenByTurn).toBe(true);
  });

  it("is a no-op when the session is shorter than <keep>", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["prompt", "/compact 100", "/quit"]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
    });
    // 2 messages (1 user + 1 assistant); 2 < 100, so it's
    // a no-op. The command still prints the summary.
    expect(out.data).toMatch(/^compacted: 2 → 2 messages \(kept last 100\)$/m);
  });
});

// ---------------------------------------------------------------------------
// 6-7. /init — generate AGENTS.md via the model
// ---------------------------------------------------------------------------

describe("/init", () => {
  it("writes AGENTS.md to the cwd via the model", async () => {
    // The /init handler bypasses agent.run (no transcript
    // pollution). The model is called ONCE for the AGENTS.md
    // content. No non-slash turns are issued, so the agent
    // is never invoked.
    const initModel = scriptedModel([
      { content: [textBlock("# My Project\n\nA test project.")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    const result = await runRepl({
      model: initModel,
      args: makeArgs({ cwd: tempCwd, sandbox: "workspace-write" }),
      lineReader: fakeLineReader(["/init", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    // No non-slash turns; result.turns === 0.
    expect(result.turns).toBe(0);
    // The model was called exactly once.
    expect(initModel.callCount()).toBe(1);
    // AGENTS.md was created in the cwd.
    const written = await fs.readFile(tempAgentsMd, "utf-8");
    expect(written).toContain("# My Project");
    expect(written).toContain("A test project.");
    // The success line is printed.
    expect(out.data).toContain(`wrote AGENTS.md: ${tempAgentsMd}`);
    expect(err.data).toBe("");
  });

  it("prints to stderr when the model throws; REPL continues", async () => {
    const throwingModel: ModelAdapter = {
      async complete() {
        throw new Error("API down");
      },
    };
    const out = new StringWritable();
    const err = new StringWritable();
    const result = await runRepl({
      model: throwingModel,
      args: makeArgs({ cwd: tempCwd, sandbox: "workspace-write" }),
      lineReader: fakeLineReader([
        "first prompt",
        "/init",
        "second prompt",
        "/quit",
      ]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    // Two non-slash turns: each invokes the model.
    // Both throw, both are caught by the agent (returns
    // [model error] result). The REPL continues.
    expect(result.turns).toBe(2);
    expect(err.data).toContain("error: model call failed: API down");
    // The "wrote AGENTS.md" line was NOT printed.
    expect(out.data).not.toMatch(/^wrote AGENTS.md:/m);
    // The agent's [model error] content is in stdout
    // (model errors go to result content, not stderr).
    expect(out.data).toContain("API down");
  });

  it("prints to stderr when the model returns no text", async () => {
    // Model returns a response with no text blocks (e.g.
    // only tool calls, but we configured tools: [] so
    // that can't happen — just an empty content array).
    const emptyModel: ModelAdapter = {
      async complete() {
        return { content: [], stopReason: "end_turn" };
      },
    };
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model: emptyModel,
      args: makeArgs({ cwd: tempCwd, sandbox: "workspace-write" }),
      lineReader: fakeLineReader(["/init", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(err.data).toContain("error: model returned no text");
    // The file was NOT created.
    let exists = true;
    try {
      await fs.access(tempAgentsMd);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("refuses to write AGENTS.md in a read-only session", async () => {
    const initModel = scriptedModel([
      { content: [textBlock("# Project")] },
    ]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model: initModel,
      // Default session mode is read-only (design invariant #1).
      args: makeArgs({ cwd: tempCwd }),
      lineReader: fakeLineReader(["/init", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(initModel.callCount()).toBe(0);
    expect(err.data).toContain("session is read-only");
  });
});

// ---------------------------------------------------------------------------
// 8. dispatch table covers all 20 built-in commands
// ---------------------------------------------------------------------------

describe("F17.5 dispatch table", () => {
  it("the dispatch table covers all 20 built-in commands (no missing, no collisions)", () => {
    // 9 from F17.2 + 8 from F17.2.5 + 3 from F17.5 = 20.
    const allNames = [
      ...BUILTIN_COMMANDS,
      ...BUILTIN_INFO_COMMANDS,
      ...BUILTIN_TIER2_COMMANDS,
    ].map((c) => c.name);
    expect(new Set(allNames).size).toBe(allNames.length);
    expect(allNames.length).toBe(20);
  });
});
