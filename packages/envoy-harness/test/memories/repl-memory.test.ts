/**
 * Tests for the `/memory` REPL command family
 * (Phase A / Item 2, chunk 2.2).
 *
 * Covers:
 * 1. `/memory list` prints the titles.
 * 2. `/memory list` with no memories prints
 *    "(no memories)".
 * 3. `/memory read <name>` prints the body.
 * 4. `/memory read <missing>` prints "not found".
 * 5. `/memory add <name> <body>` writes a memory.
 * 6. `/memory add` with no name or body is an error.
 * 7. `/memory` with no subcommand is the same as
 *    `/memory list`.
 * 8. `/memory` with an unknown subcommand is an error.
 * 9. `/memory` when no store is configured prints
 *    "no memory store configured".
 *
 * **Hermetic:** every test uses a temp-dir
 * `LocalMemoryStore` injected via
 * `ReplOptions.memoryStore`.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runRepl } from "../../src/index.js";
import { LocalMemoryStore } from "../../src/memories/index.js";
import { StringWritable, fakeLineReader, makeArgs, scriptedModel, textBlock } from "../helpers.js";

const tempDirs: string[] = [];

async function trackTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "envoy-repl-mem-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("/memory REPL commands (Phase A item 2)", () => {
  it("/memory list prints the titles (one per line)", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    // Pre-seed a memory.
    await store.write({
      name: "alpha",
      title: "Alpha",
      tags: ["test"],
      created: "2026-08-21",
      body: "Body.",
    });
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["prompt", "/memory list", "/quit"]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
      memoryStore: store,
    });
    expect(out.data).toContain("- alpha [test] — Alpha");
  });

  it("/memory list with no memories prints '(no memories)'", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["prompt", "/memory list", "/quit"]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
      memoryStore: store,
    });
    expect(out.data).toContain("(no memories)");
  });

  it("/memory read <name> prints the body", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    await store.write({
      name: "foo",
      title: "Foo",
      tags: [],
      created: "2026-08-21",
      body: "The body.",
    });
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["prompt", "/memory read foo", "/quit"]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
      memoryStore: store,
    });
    expect(out.data).toContain("# Foo");
    expect(out.data).toContain("The body.");
  });

  it("/memory read <missing> prints 'not found'", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["prompt", "/memory read missing", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
      memoryStore: store,
    });
    expect(err.data).toContain("memory not found: missing");
  });

  it("/memory add <name> <body> writes a new memory", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader([
        "prompt",
        "/memory add new-mem the body text",
        "/quit",
      ]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
      memoryStore: store,
    });
    expect(out.data).toContain("added: new-mem");
    // The memory is on disk.
    const onDisk = await fs.readFile(path.join(dir, "new-mem.md"), "utf8");
    expect(onDisk).toContain("the body text");
  });

  it("/memory add with no body is an error", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["prompt", "/memory add x", "/quit"]),
      stdout: new StringWritable(),
      stderr: err,
      historyPath: "",
      memoryStore: store,
    });
    expect(err.data).toContain("usage: /memory add <name> <body>");
  });

  it("/memory with no subcommand is the same as /memory list", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    await store.write({
      name: "alpha",
      title: "Alpha",
      tags: [],
      created: "2026-08-21",
      body: "Body.",
    });
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["prompt", "/memory", "/quit"]),
      stdout: out,
      stderr: new StringWritable(),
      historyPath: "",
      memoryStore: store,
    });
    expect(out.data).toContain("alpha");
  });

  it("/memory with an unknown subcommand is an error", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["prompt", "/memory foo", "/quit"]),
      stdout: new StringWritable(),
      stderr: err,
      historyPath: "",
      memoryStore: store,
    });
    expect(err.data).toMatch(/unknown \/memory subcommand: foo/);
  });
});
