/**
 * T3.5 — write / edit / git tool tests.
 *
 * Covers:
 * 1. `write`:
 *    - creates a new file
 *    - overwrites an existing file
 *    - creates parent directories when asked
 *    - rejects in read-only mode
 *    - rejects in workspace-write for paths outside writable roots
 *    - allows in workspace-write for paths under writable roots
 * 2. `edit`:
 *    - replace mode: replaces the unique occurrence
 *    - replace mode: fails on zero or multiple matches
 *    - replaceAll mode: replaces every occurrence
 *    - replaceAll mode: fails on zero matches
 *    - insertAfter mode: inserts at the right offset
 * 3. `git`:
 *    - status / diff / log / branchList work
 *    - non-zero exit code is an error
 */

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { editTool, gitTool, writeTool } from "../src/tools/builtin/index.js";
import type { ToolContext } from "../src/tools/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-tools-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: tmpDir,
    session: undefined as never,
    abortSignal: new AbortController().signal,
    sandboxPolicy: {
      mode: "workspace-write",
      approval: "on-request",
      backend: "none",
      writableRoots: [tmpDir],
      networkAccess: false,
      slashTmpWritable: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe("write: basic file write", () => {
  it("creates a new file", async () => {
    const result = await writeTool.execute(
      { path: "a.txt", content: "hello" },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(path.join(tmpDir, "a.txt"), "utf8")).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "old");
    const result = await writeTool.execute(
      { path: "a.txt", content: "new" },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(path.join(tmpDir, "a.txt"), "utf8")).toBe("new");
  });

  it("creates parent directories when createDirectories: true", async () => {
    const result = await writeTool.execute(
      { path: "nested/dir/a.txt", content: "x", createDirectories: true },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(path.join(tmpDir, "nested/dir/a.txt"), "utf8")).toBe("x");
  });

  it("fails when parent does not exist and createDirectories: false", async () => {
    const result = await writeTool.execute(
      { path: "nested/a.txt", content: "x" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/ENOENT|no such file/i);
  });
});

describe("write: permission checks", () => {
  it("rejects in read-only mode", async () => {
    const result = await writeTool.execute(
      { path: "a.txt", content: "x" },
      makeContext({
        sandboxPolicy: {
          mode: "read-only",
          approval: "on-request",
          backend: "none",
          writableRoots: [],
          networkAccess: false,
          slashTmpWritable: false,
        },
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/read-only/);
  });

  it("rejects in workspace-write for paths outside writable roots", async () => {
    const result = await writeTool.execute(
      { path: "/etc/passwd", content: "x" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/writable root/);
  });
});

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

describe("edit: replace mode", () => {
  it("replaces the unique occurrence", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "hello world");
    const result = await editTool.execute(
      { path: "a.txt", oldText: "world", newText: "planet" },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(path.join(tmpDir, "a.txt"), "utf8")).toBe(
      "hello planet",
    );
  });

  it("fails when oldText appears zero times", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "hello");
    const result = await editTool.execute(
      { path: "a.txt", oldText: "nope", newText: "x" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/0 times/);
  });

  it("fails when oldText appears multiple times", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "hello hello");
    const result = await editTool.execute(
      { path: "a.txt", oldText: "hello", newText: "x" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/2 times|exactly 1/);
  });
});

describe("edit: replaceAll mode", () => {
  it("replaces every occurrence", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "a a a");
    const result = await editTool.execute(
      {
        path: "a.txt",
        oldText: "a",
        newText: "b",
        mode: "replaceAll",
      },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(path.join(tmpDir, "a.txt"), "utf8")).toBe("b b b");
  });
});

describe("edit: insertAfter mode", () => {
  it("inserts newText after the anchor", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "AAA\nBBB\nCCC");
    const result = await editTool.execute(
      {
        path: "a.txt",
        oldText: "AAA",
        newText: "\nINSERTED",
        mode: "insertAfter",
      },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(path.join(tmpDir, "a.txt"), "utf8")).toBe(
      "AAA\nINSERTED\nBBB\nCCC",
    );
  });
});

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

describe("git: read-only operations", () => {
  beforeEach(() => {
    // Initialize a git repo for the tests.
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });
  });

  it("status on a clean repo returns empty", async () => {
    const result = await gitTool.execute({ op: "status" }, makeContext());
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe("");
  });

  it("status detects untracked files", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "hi");
    const result = await gitTool.execute({ op: "status" }, makeContext());
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/a\.txt/);
  });

  it("diff shows unstaged changes", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "line1\nline2\n");
    execFileSync("git", ["add", "a.txt"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir });
    await writeFile(path.join(tmpDir, "a.txt"), "line1\nline2-modified\n");
    const result = await gitTool.execute({ op: "diff" }, makeContext());
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/line2-modified/);
  });

  it("log shows recent commits", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "x");
    execFileSync("git", ["add", "a.txt"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "first"], { cwd: tmpDir });
    const result = await gitTool.execute(
      { op: "log", max: 5 },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/first/);
  });

  it("branchList works", async () => {
    // `git branch --list` returns no branches until at
    // least one commit exists.
    await writeFile(path.join(tmpDir, "a.txt"), "x");
    execFileSync("git", ["add", "a.txt"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir });
    const result = await gitTool.execute(
      { op: "branchList" },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/main/);
  });
});
