/**
 * F17.6 tests — Tier 2 batch 2 REPL commands.
 *
 * Covers:
 * 1. BUILTIN_TIER2_BATCH2_COMMANDS has the 2 expected commands.
 * 2. /agents — prints "no sub-agents" when the agent has no
 *    meshSubmitter.
 * 3. /agents — prints the spawned sub-agents from the
 *    injected registry (status, cost, duration).
 * 4. /diff — prints "no changes" when in a git repo with
 *    no unstaged changes.
 * 5. /diff — prints the actual diff when a file is modified.
 * 6. /diff — prints an error to stderr when the cwd is not
 *    a git repository.
 * 7. dispatch table covers all 22 built-in commands.
 *
 * Total: 7 tests.
 */

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_COMMANDS,
  BUILTIN_INFO_COMMANDS,
  BUILTIN_TIER2_BATCH2_COMMANDS,
  BUILTIN_TIER2_BATCH3_COMMANDS,
  BUILTIN_TIER2_COMMANDS,
  runRepl,
  type SubagentRegistry,
  type SubagentRecord,
} from "../src/index.js";
import {
  StringWritable,
  fakeLineReader,
  makeArgs,
  scriptedModel,
  textBlock,
} from "./helpers.js";

/**
 * Make a `SubagentRegistry` that returns the given records.
 * The `list()` method always returns the same array reference
 * (matches the LocalMeshSubmitter's behavior).
 */
function makeRegistry(records: ReadonlyArray<SubagentRecord>): SubagentRegistry {
  return {
    list: () => records,
  };
}

// ---------------------------------------------------------------------------
// Per-test setup: fresh temp git repo for /diff tests
// ---------------------------------------------------------------------------

let tempRepo: string;
let tempNonRepo: string;

beforeEach(async () => {
  // Temp dir that IS a git repo: init, add, commit a file.
  tempRepo = await fs.mkdtemp(
    path.join(os.tmpdir(), `envoy-f17-6-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  );
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tempRepo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempRepo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tempRepo });
    await fs.writeFile(path.join(tempRepo, "README.md"), "Hello\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: tempRepo });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: tempRepo });
  } catch {
    // git not available — tests will skip or fail gracefully.
  }
  // Temp dir that is NOT a git repo.
  tempNonRepo = await fs.mkdtemp(
    path.join(os.tmpdir(), `envoy-f17-6-norepo-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  );
});

afterEach(async () => {
  for (const dir of [tempRepo, tempNonRepo]) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ---------------------------------------------------------------------------
// 1. BUILTIN_TIER2_BATCH2_COMMANDS shape
// ---------------------------------------------------------------------------

describe("BUILTIN_TIER2_BATCH2_COMMANDS", () => {
  it("has the 2 expected commands", () => {
    const names = new Set(BUILTIN_TIER2_BATCH2_COMMANDS.map((c) => c.name));
    expect(names).toEqual(new Set(["/agents", "/diff"]));
  });

  it("all 4 BUILTIN_* arrays have no name collisions", () => {
    const all = [
      ...BUILTIN_COMMANDS,
      ...BUILTIN_INFO_COMMANDS,
      ...BUILTIN_TIER2_COMMANDS,
      ...BUILTIN_TIER2_BATCH2_COMMANDS,
    ];
    const names = all.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// 2-3. /agents
// ---------------------------------------------------------------------------

describe("/agents", () => {
  it("prints 'no sub-agents' when no registry is configured", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/agents", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("no sub-agents");
    expect(err.data).toBe("");
  });

  it("prints 'no sub-agents spawned' when registry returns empty list", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/agents", "/quit"]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
      subagentRegistry: makeRegistry([]),
    });
    expect(out.data).toContain("no sub-agents spawned");
  });

  it("prints the spawned sub-agents from the injected registry", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const records: ReadonlyArray<SubagentRecord> = [
      {
        sessionId: "11111111-1111-1111-1111-111111111111",
        capabilityTag: "research",
        objective: "find the runbook",
        startedAt: "2026-08-19T10:00:00.000Z",
        completedAt: "2026-08-19T10:00:03.200Z",
        durationMs: 3200,
        status: "completed",
        costUsd: 0.0012,
      },
      {
        sessionId: "22222222-2222-2222-2222-222222222222",
        capabilityTag: "code-review",
        objective: "review the diff",
        startedAt: "2026-08-19T10:00:01.000Z",
        status: "running",
      },
    ];
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/agents", "/quit"]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
      subagentRegistry: makeRegistry(records),
    });
    // Header line.
    expect(out.data).toMatch(/sub-agents: 2 \(1 running\)/);
    // One line per record.
    expect(out.data).toContain("research");
    expect(out.data).toContain("code-review");
    expect(out.data).toContain("11111111…");
    expect(out.data).toContain("22222222…");
    // Cost line for the completed record.
    expect(out.data).toContain("$0.0012");
    // The "— " placeholder for the running record (no cost yet).
    expect(out.data).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// 4-6. /diff
// ---------------------------------------------------------------------------

describe("/diff", () => {
  it("prints 'no changes' when in a git repo with no unstaged changes", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs({ cwd: tempRepo }),
      lineReader: fakeLineReader(["/diff", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("no changes");
    expect(err.data).toBe("");
  });

  it("prints the actual diff when a file is modified", async () => {
    // Modify the committed file (change "Hello" to "Hi"
    // — produces a clear one-line diff with both - and +).
    await fs.writeFile(
      path.join(tempRepo, "README.md"),
      "Hi\n",
      "utf-8",
    );
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs({ cwd: tempRepo }),
      lineReader: fakeLineReader(["/diff", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    // The diff should mention both the removed and added line.
    expect(out.data).toContain("-Hello");
    expect(out.data).toContain("+Hi");
    expect(err.data).toBe("");
  });

  it("prints an error to stderr when the cwd is not a git repository", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs({ cwd: tempNonRepo }),
      lineReader: fakeLineReader(["/diff", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    // git's error message includes "fatal: not a git
    // repository" (or similar). We just check the
    // error path was taken (the message went to stderr,
    // not stdout).
    expect(err.data).toMatch(/error:/);
    expect(err.data).toMatch(/not a git repository|fatal/i);
    // The stdout should NOT contain "no changes" (the
    // command bailed before checking the output).
    expect(out.data).not.toContain("no changes");
  });
});

// ---------------------------------------------------------------------------
// 7. dispatch table covers all 22 built-in commands
// ---------------------------------------------------------------------------

describe("F17.6 dispatch table", () => {
  it("the dispatch table covers all 25 built-in commands (no missing, no collisions)", () => {
    // 9 from F17.2 + 8 from F17.2.5 + 3 from F17.5 + 2 from F17.6
    // + 2 from F14.1 (/rename, /copy) = 24. /undo is deferred.
    const allNames = [
      ...BUILTIN_COMMANDS,
      ...BUILTIN_INFO_COMMANDS,
      ...BUILTIN_TIER2_COMMANDS,
      ...BUILTIN_TIER2_BATCH2_COMMANDS,
      ...BUILTIN_TIER2_BATCH3_COMMANDS,
    ].map((c) => c.name);
    expect(new Set(allNames).size).toBe(allNames.length);
    expect(allNames.length).toBe(25);
  });

  it("/help output mentions /agents and /diff", async () => {
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
    expect(out.data).toContain("/agents");
    expect(out.data).toContain("/diff");
  });
});
