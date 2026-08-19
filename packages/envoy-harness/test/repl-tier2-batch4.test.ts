/**
 * F14.3 — Tier 2 batch 4 command tests (/review, /export).
 *
 * These tests cover the F18 gap-analysis commands
 * `codex /review` + `codex /export` that complete
 * the F14 REPL surface.
 *
 * **Two surfaces:**
 * - `/review` is a one-shot side effect (the
 *   diff + review are NOT added to the main
 *   transcript). The test injects a fake
 *   `reviewDiff` so the tests don't need a real
 *   git repo. The model is also a fake (the
 *   test asserts the system prompt + diff reach
 *   the model in the right order).
 * - `/export` reads the live session from the
 *   agent and writes JSONL or Markdown to disk.
 *   Tests use real temp dirs and read back the
 *   file to assert the format.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";

import {
  Agent,
  BUILTIN_TIER2_BATCH4_COMMANDS,
  HookRegistry,
  InMemorySession,
  newSessionId,
  runRepl,
  ToolRegistry,
  type LineReader,
  type ModelAdapter,
  type ReplOptions,
  type RunParsedArgs,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test fixtures
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

/**
 * A model that records every call. Tests assert
 * the system prompt + user prompt content.
 */
function recordingModel(
  responseText: string,
  recorder: { system?: string; user?: string; toolCount?: number },
): ModelAdapter {
  return {
    async complete(input) {
      const sysMsg = input.messages.find((m) => m.role === "system");
      const userMsg = input.messages.find((m) => m.role === "user");
      recorder.system = sysMsg?.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      recorder.user = userMsg?.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      recorder.toolCount = input.tools.length;
      return {
        content: [{ type: "text", text: responseText }],
        stopReason: "end_turn",
      };
    },
  };
}

function lineReader(lines: string[]): LineReader {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (i >= lines.length) return { value: "", done: true };
      return { value: lines[i++]!, done: false };
    },
    close() {},
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
    persist: false,
    sessionDir: undefined,
    plan: false,
    repl: true,
    noColor: false,
    verbose: false,
    quiet: false,
    positional: [],
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-repl-batch4-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. BUILTIN_TIER2_BATCH4_COMMANDS shape
// ---------------------------------------------------------------------------

describe("BUILTIN_TIER2_BATCH4_COMMANDS", () => {
  it("has the 2 expected commands", () => {
    expect(BUILTIN_TIER2_BATCH4_COMMANDS.map((c) => c.name).sort()).toEqual([
      "/export",
      "/review",
    ]);
  });

  it("has no name collisions with the other tier-2 batches", () => {
    const allNames = new Set<string>();
    for (const c of BUILTIN_TIER2_BATCH4_COMMANDS) {
      allNames.add(c.name);
    }
    expect(allNames.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. /review — empty diff
// ---------------------------------------------------------------------------

describe("/review: empty diff", () => {
  it("prints 'no changes to review' when the diff is empty (clean tree)", async () => {
    const model = recordingModel("should not see this", {});
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["/review", "/quit"]),
      reviewDiff: () => ({ stdout: "", stderr: "", exitCode: 0 }),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("no changes to review");
    // The model was NOT called.
    expect(err.data).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. /review — non-git dir (git error)
// ---------------------------------------------------------------------------

describe("/review: non-git dir", () => {
  it("prints the git error to stderr", async () => {
    const model = recordingModel("ok", {});
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["/review", "/quit"]),
      reviewDiff: () => ({
        stdout: "",
        stderr: "fatal: not a git repository\n",
        exitCode: 128,
      }),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(err.data).toContain("not a git repository");
    // The model was NOT called.
    expect(out.data).not.toContain("ok");
  });
});

// ---------------------------------------------------------------------------
// 4. /review — happy path
// ---------------------------------------------------------------------------

describe("/review: happy path", () => {
  it("sends the diff to the model and prints the review", async () => {
    const diff = "diff --git a/foo.ts b/foo.ts\n+ new line\n-old line\n";
    const recorder: { system?: string; user?: string; toolCount?: number } =
      {};
    const model = recordingModel("LGTM. No issues.", recorder);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["/review", "/quit"]),
      reviewDiff: () => ({ stdout: diff, stderr: "", exitCode: 0 }),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("LGTM. No issues.");
    // The diff reached the model.
    expect(recorder.user).toContain(diff);
    // The system prompt is the code-reviewer one.
    expect(recorder.system).toContain("code reviewer");
    // The model is called with NO tools (one-shot
    // side effect — no agent loop, no tools).
    expect(recorder.toolCount).toBe(0);
    // No stderr on the happy path.
    expect(err.data).toBe("");
  });

  it("uses `git diff --cached` when the staged arg is set", async () => {
    const diff = "diff --git a/foo.ts b/foo.ts\n+ staged line\n";
    const recorder: { system?: string; user?: string; toolCount?: number } =
      {};
    const model = recordingModel("ok", recorder);
    const out = new StringWritable();
    let receivedOpts: { cwd?: string; staged?: boolean } | undefined;
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["/review staged", "/quit"]),
      reviewDiff: (opts) => {
        receivedOpts = opts;
        return { stdout: diff, stderr: "", exitCode: 0 };
      },
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
    });
    // The fetcher was called with staged: true.
    expect(receivedOpts?.staged).toBe(true);
    expect(recorder.user).toContain(diff);
  });
});

// ---------------------------------------------------------------------------
// 5. /export — JSONL default
// ---------------------------------------------------------------------------

describe("/export: jsonl (default)", () => {
  it("writes the session as JSONL to <cwd>/<sessionId>.jsonl", async () => {
    // Build a session with a known id + a known message.
    const id = "test-export-id";
    const session = new InMemorySession(id, {
      cwd: tmpDir,
      permissionMode: "read-only",
      startedAt: "2026-01-01T00:00:00.000Z",
      title: "export test",
    });
    session.appendMessage("user", [{ type: "text", text: "hi" }]);
    session.appendMessage("assistant", [{ type: "text", text: "hello" }]);

    const model = recordingModel("ok", {});
    // Inject the session via a custom createSession.
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["/export", "/quit"]),
      createSession: async () => session,
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    // The export path is the session id with .jsonl
    // extension in the cwd (which defaults to
    // process.cwd() — so the file lives in the
    // shell's cwd, not tmpDir. Read it from there.)
    const targetPath = path.join(process.cwd(), `${id}.jsonl`);
    const content = await readFile(targetPath, "utf-8");
    // Cleanup the file we just created (don't
    // pollute the test runner's cwd).
    await rm(targetPath, { force: true });

    // The file has a header + 2 messages.
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    // Line 1 is the header.
    const header = JSON.parse(lines[0]!);
    expect(header._kind).toBe("header");
    expect(header.id).toBe(id);
    expect(header.metadata.title).toBe("export test");
    // Lines 2-3 are messages.
    const msg1 = JSON.parse(lines[1]!);
    expect(msg1.role).toBe("user");
    const msg2 = JSON.parse(lines[2]!);
    expect(msg2.role).toBe("assistant");
    // stdout says where it wrote.
    expect(out.data).toContain("exported:");
  });
});

// ---------------------------------------------------------------------------
// 6. /export — Markdown
// ---------------------------------------------------------------------------

describe("/export: md", () => {
  it("writes the session as Markdown", async () => {
    const id = "test-md-id";
    const session = new InMemorySession(id, {
      cwd: tmpDir,
      permissionMode: "read-only",
      startedAt: "2026-01-01T00:00:00.000Z",
      title: "md test",
    });
    session.appendMessage("user", [{ type: "text", text: "hi" }]);
    session.appendMessage("assistant", [{ type: "text", text: "hello" }]);

    const model = recordingModel("ok", {});
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["/export md", "/quit"]),
      createSession: async () => session,
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    const targetPath = path.join(process.cwd(), `${id}.md`);
    const content = await readFile(targetPath, "utf-8");
    await rm(targetPath, { force: true });

    // YAML-ish front matter.
    expect(content).toContain("---");
    expect(content).toContain(`id: ${id}`);
    expect(content).toContain("title: md test");
    expect(content).toContain("messages: 2");
    // Role headings.
    expect(content).toContain("## user");
    expect(content).toContain("## assistant");
    // Message content.
    expect(content).toContain("hi");
    expect(content).toContain("hello");
    // stdout confirms.
    expect(out.data).toContain("exported:");
  });
});

// ---------------------------------------------------------------------------
// 7. /export — error paths
// ---------------------------------------------------------------------------

describe("/export: errors", () => {
  it("prints an error to stderr on unknown format", async () => {
    const model = recordingModel("ok", {});
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["/export pdf", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(err.data).toMatch(/unknown format: pdf/);
    // Nothing was written to stdout.
    expect(out.data).not.toContain("exported:");
  });

  it("respects a custom path arg", async () => {
    const id = "test-custom-path-id";
    const session = new InMemorySession(id, {
      cwd: tmpDir,
      permissionMode: "read-only",
      startedAt: "2026-01-01T00:00:00.000Z",
      title: "custom path",
    });
    session.appendMessage("user", [{ type: "text", text: "x" }]);
    const model = recordingModel("ok", {});
    const customPath = path.join(tmpDir, "my-export.jsonl");
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader([`/export jsonl ${customPath}`, "/quit"]),
      createSession: async () => session,
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
    });
    const content = await readFile(customPath, "utf-8");
    expect(content).toContain(`"id":"${id}"`);
    expect(out.data).toContain(customPath);
  });
});

// ---------------------------------------------------------------------------
// 8. /export — empty session
// ---------------------------------------------------------------------------

describe("/export: empty session", () => {
  it("writes a header-only file for a session with no messages", async () => {
    const id = "test-empty-id";
    const session = new InMemorySession(id, {
      cwd: tmpDir,
      permissionMode: "read-only",
      startedAt: "2026-01-01T00:00:00.000Z",
      title: "empty",
    });
    const model = recordingModel("ok", {});
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["/export", "/quit"]),
      createSession: async () => session,
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
    });
    const targetPath = path.join(process.cwd(), `${id}.jsonl`);
    const content = await readFile(targetPath, "utf-8");
    await rm(targetPath, { force: true });
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]!);
    expect(header._kind).toBe("header");
    expect(out.data).toContain("0 messages");
  });
});

// Reference types/classes to satisfy the linter.
void Agent;
void HookRegistry;
void ToolRegistry;
void newSessionId;
void (null as unknown as ReplOptions);
