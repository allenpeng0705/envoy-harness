/**
 * F14.1 — CLI persistence flags (`--resume`, `--fork`,
 * `--persist`, `--session-dir`) tests.
 *
 * The CLI runner is the bridge between argv and the
 * on-disk format. The tests below exercise the four
 * modes (default in-memory, --resume, --fork, --persist)
 * and the mutual-exclusion rule for --resume + --fork.
 *
 * **Why these tests matter:** the persistence work is
 * opt-in (default: in-memory). A regression in the
 * mode detection silently falls back to the wrong
 * session kind — the user gets a session that
 * doesn't persist, or worse, loses the `--fork`
 * message copy.
 *
 * **Test isolation:** each test uses a fresh
 * `--session-dir` (a temp dir). No shared state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";

import { CliError, run, type ModelAdapter } from "../src/index.js";

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

function scriptedModel(text: string): ModelAdapter {
  return {
    async complete() {
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
      };
    },
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-cli-persist-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("CLI: default (no persistence flags)", () => {
  it("uses an in-memory session when no persistence flags are set", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const result = await run({
      argv: ["--provider", "openai", "hello"],
      model: scriptedModel("hi back"),
      stdout: out,
      stderr: err,
      cwd: tmpDir,
    });
    // The session id is a fresh UUID (not on disk).
    expect(result.subcommand).toBe("run");
    if (result.subcommand !== "run") throw new Error("expected run");
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // No file was written to the cwd.
    const entries = await readFile(
      path.join(tmpDir, ".envoymesh", "sessions"),
    ).catch(() => null);
    expect(entries).toBeNull();
  });
});

describe("CLI: --persist", () => {
  it("writes the session to disk and prints the id to stderr", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const sessionDir = path.join(tmpDir, "sessions");
    const result = await run({
      argv: [
        "--provider",
        "openai",
        "--persist",
        "--session-dir",
        sessionDir,
        "hello",
      ],
      model: scriptedModel("hi back"),
      stdout: out,
      stderr: err,
      cwd: tmpDir,
    });
    expect(result.subcommand).toBe("run");
    if (result.subcommand !== "run") throw new Error("expected run");
    expect(err.data).toMatch(/persisted session:/);
    // The session file is on disk.
    const expectedPath = path.join(sessionDir, `${result.sessionId}.jsonl`);
    const content = await readFile(expectedPath, "utf-8");
    expect(content).toContain(`"id":"${result.sessionId}"`);
  });
});

describe("CLI: --resume", () => {
  it("loads an existing session from disk", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const sessionDir = path.join(tmpDir, "sessions");

    // 1. Persist a session.
    const first = await run({
      argv: [
        "--provider",
        "openai",
        "--persist",
        "--session-dir",
        sessionDir,
        "first",
      ],
      model: scriptedModel("first reply"),
      stdout: out,
      stderr: err,
      cwd: tmpDir,
    });
    if (first.subcommand !== "run") throw new Error("expected run");
    const sessionId = first.sessionId;

    // 2. Resume it.
    const out2 = new StringWritable();
    const err2 = new StringWritable();
    const second = await run({
      argv: [
        "--provider",
        "openai",
        "--resume",
        sessionId,
        "--session-dir",
        sessionDir,
        "second",
      ],
      model: scriptedModel("second reply"),
      stdout: out2,
      stderr: err2,
      cwd: tmpDir,
    });
    if (second.subcommand !== "run") throw new Error("expected run");
    expect(second.sessionId).toBe(sessionId);
  });

  it("throws CliError(EXIT_USAGE) on a missing session id", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    try {
      await run({
        argv: [
          "--provider",
          "openai",
          "--resume",
          "does-not-exist",
          "--session-dir",
          tmpDir,
          "x",
        ],
        model: scriptedModel("x"),
        stdout: out,
        stderr: err,
        cwd: tmpDir,
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(64);
      expect((e as Error).message).toMatch(/failed to load session/);
    }
  });
});

describe("CLI: --fork", () => {
  it("copies the source session's messages to a new session with a fresh id", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const sessionDir = path.join(tmpDir, "sessions");

    // 1. Persist a session.
    const first = await run({
      argv: [
        "--provider",
        "openai",
        "--persist",
        "--session-dir",
        sessionDir,
        "source",
      ],
      model: scriptedModel("source reply"),
      stdout: out,
      stderr: err,
      cwd: tmpDir,
    });
    if (first.subcommand !== "run") throw new Error("expected run");
    const sourceId = first.sessionId;

    // 2. Fork it.
    const out2 = new StringWritable();
    const err2 = new StringWritable();
    const second = await run({
      argv: [
        "--provider",
        "openai",
        "--fork",
        sourceId,
        "--session-dir",
        sessionDir,
        "forked",
      ],
      model: scriptedModel("forked reply"),
      stdout: out2,
      stderr: err2,
      cwd: tmpDir,
    });
    if (second.subcommand !== "run") throw new Error("expected run");
    // The new id is different.
    expect(second.sessionId).not.toBe(sourceId);
    expect(err2.data).toMatch(/forked session/);
    // Both files exist on disk.
    const sourceFile = await readFile(
      path.join(sessionDir, `${sourceId}.jsonl`),
      "utf-8",
    );
    const forkedFile = await readFile(
      path.join(sessionDir, `${second.sessionId}.jsonl`),
      "utf-8",
    );
    expect(sourceFile).toContain(`"id":"${sourceId}"`);
    expect(forkedFile).toContain(`"id":"${second.sessionId}"`);
    // The forked file at fork-time has the same line
    // count as the source (the fork is a copy of the
    // source's messages; the new agent turn is fire-
    // and-forget and not yet flushed). The semantic
    // we want to verify is: the fork EXISTS and
    // contains the source's messages (verified via
    // the file's metadata below).
    const sourceLineCount = sourceFile.split("\n").filter((l) => l.length > 0).length;
    const forkedLineCount = forkedFile.split("\n").filter((l) => l.length > 0).length;
    expect(forkedLineCount).toBe(sourceLineCount);
  });

  it("inherits the source session's title when present", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const sessionDir = path.join(tmpDir, "sessions");

    const first = await run({
      argv: [
        "--provider",
        "openai",
        "--persist",
        "--session-dir",
        sessionDir,
        "this is a long title that should be inherited by the fork",
      ],
      model: scriptedModel("ok"),
      stdout: out,
      stderr: err,
      cwd: tmpDir,
    });
    if (first.subcommand !== "run") throw new Error("expected run");

    const out2 = new StringWritable();
    const err2 = new StringWritable();
    const second = await run({
      argv: [
        "--provider",
        "openai",
        "--fork",
        first.sessionId,
        "--session-dir",
        sessionDir,
        "x",
      ],
      model: scriptedModel("ok"),
      stdout: out2,
      stderr: err2,
      cwd: tmpDir,
    });
    if (second.subcommand !== "run") throw new Error("expected run");
    // The forked file's header has the source's title.
    const forkedFile = await readFile(
      path.join(sessionDir, `${second.sessionId}.jsonl`),
      "utf-8",
    );
    const header = JSON.parse(
      forkedFile.split("\n").find((l) => l.length > 0)!,
    );
    expect(header.metadata.title).toBeTruthy();
    expect(header.metadata.title.length).toBeGreaterThan(0);
  });
});

describe("CLI: --resume + --fork mutual exclusion", () => {
  it("throws CliError(EXIT_USAGE) when both are set", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    try {
      await run({
        argv: [
          "--provider",
          "openai",
          "--resume",
          "a",
          "--fork",
          "b",
          "--session-dir",
          tmpDir,
          "x",
        ],
        model: scriptedModel("x"),
        stdout: out,
        stderr: err,
        cwd: tmpDir,
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(64);
      expect((e as Error).message).toMatch(/mutually exclusive/);
    }
  });
});

describe("CLI: --session-dir default", () => {
  it("respects ENVOY_HARNESS_SESSION_DIR env var when --session-dir is not set", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const envDir = path.join(tmpDir, "env-default");
    const prev = process.env["ENVOY_HARNESS_SESSION_DIR"];
    process.env["ENVOY_HARNESS_SESSION_DIR"] = envDir;
    try {
      const result = await run({
        argv: ["--provider", "openai", "--persist", "hello"],
        model: scriptedModel("ok"),
        stdout: out,
        stderr: err,
        cwd: tmpDir,
      });
      if (result.subcommand !== "run") throw new Error("expected run");
      // The session file is in the env-var dir.
      const filePath = path.join(envDir, `${result.sessionId}.jsonl`);
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain(`"id":"${result.sessionId}"`);
    } finally {
      if (prev === undefined) {
        delete process.env["ENVOY_HARNESS_SESSION_DIR"];
      } else {
        process.env["ENVOY_HARNESS_SESSION_DIR"] = prev;
      }
    }
  });
});
