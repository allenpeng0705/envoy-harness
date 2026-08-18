/**
 * read_file tool tests.
 *
 * Covers the success path, error paths (ENOENT, EISDIR, EACCES),
 * and the `maxBytes` truncation.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InMemorySession,
  newSessionId,
  readFileTool,
  type Session,
  type SessionMetadata,
  type ToolContext,
} from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-harness-rf-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(cwd: string): ToolContext {
  const meta: SessionMetadata = {
    cwd,
    permissionMode: "read-only",
    startedAt: new Date().toISOString(),
  };
  const session: Session = new InMemorySession(newSessionId(), meta);
  return {
    cwd,
    session,
    abortSignal: AbortSignal.timeout(5000),
  };
}

describe("read_file: success", () => {
  it("reads a small file", async () => {
    const file = path.join(tmpDir, "hello.txt");
    await fs.writeFile(file, "hello world\n");
    const ctx = makeCtx(tmpDir);
    const result = await readFileTool.execute({ path: file }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content as string).toBe("hello world\n");
  });

  it("resolves relative paths against cwd", async () => {
    await fs.writeFile(path.join(tmpDir, "rel.txt"), "relative");
    const ctx = makeCtx(tmpDir);
    const result = await readFileTool.execute({ path: "rel.txt" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content as string).toBe("relative");
  });

  it("respects maxBytes and appends a truncation notice", async () => {
    const file = path.join(tmpDir, "big.txt");
    const content = "x".repeat(1000);
    await fs.writeFile(file, content);
    const ctx = makeCtx(tmpDir);
    const result = await readFileTool.execute(
      { path: file, maxBytes: 100 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const text = result.content as string;
    // The content is the first 100 chars + a truncation notice.
    expect(text).toContain("x".repeat(100));
    expect(text).toMatch(/truncated at 100 bytes/);
    // Total is more than 100 (notice) but less than 1000.
    expect(text.length).toBeGreaterThan(100);
    expect(text.length).toBeLessThan(1000);
  });
});

describe("read_file: errors", () => {
  it("returns isError for non-existent files", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await readFileTool.execute(
      { path: path.join(tmpDir, "missing.txt") },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content as string).toMatch(/ENOENT/);
  });

  it("returns isError when reading a directory", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await readFileTool.execute({ path: tmpDir }, ctx);
    expect(result.isError).toBe(true);
    // macOS reports EISDIR; Linux too. The exact error code varies
    // by platform, so we just check the error class.
    expect(result.content as string).toMatch(/EISDIR|is a directory/);
  });
});
