/**
 * Tests for `src/memories/store.ts` — the
 * `LocalMemoryStore` + file format parser.
 *
 * Covers:
 * 1. `list()` returns the right `MemoryMeta[]` for a
 *    directory with 3 memories + a reserved
 *    `MEMORY.md`.
 * 2. `read(name)` returns the parsed body; missing
 *    name returns `undefined`.
 * 3. `write(mem)` overwrites; metadata reflects the
 *    write.
 * 4. YAML frontmatter is parsed; missing frontmatter
 *    is OK.
 * 5. Reserved filenames are filtered out of `list()`.
 * 6. Names with invalid characters are rejected at
 *    write time.
 * 7. `parseMemoryFile` / `serializeMemoryFile`
 *    round-trip.
 *
 * **Hermetic:** every test uses a temp dir from
 * `mkdtemp` and disposes of it.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalMemoryStore,
  parseMemoryFile,
  serializeMemoryFile,
} from "../../src/memories/store.js";

/** Create a fresh temp dir; the test must `rm` it
 *  (handled by `cleanup` below). */
async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(tmpdir(), "envoy-mem-test-"));
}

const tempDirs: string[] = [];

async function trackTempDir(): Promise<string> {
  const dir = await makeTempDir();
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

// ---------------------------------------------------------------------------
// LocalMemoryStore
// ---------------------------------------------------------------------------

describe("LocalMemoryStore.list", () => {
  it("returns an empty list for a missing directory", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: `${dir}/nonexistent` });
    expect(await store.list()).toEqual([]);
  });

  it("returns metadata for 3 memories, sorted by name", async () => {
    const dir = await trackTempDir();
    await fs.writeFile(
      path.join(dir, "alpha.md"),
      "# Alpha\n\nFirst memory.",
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "bravo.md"),
      "---\ntags: [typescript]\n---\n\n# Bravo\n\nSecond memory.",
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "charlie.md"),
      "# Charlie\n\nThird memory.",
      "utf8",
    );
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const list = await store.list();
    expect(list.map((m) => m.name)).toEqual(["alpha", "bravo", "charlie"]);
    expect(list[1]?.tags).toEqual(["typescript"]);
    expect(list[1]?.title).toBe("Bravo");
  });

  it("filters out reserved filenames (MEMORY.md, memory_summary.md)", async () => {
    const dir = await trackTempDir();
    await fs.writeFile(path.join(dir, "alpha.md"), "# Alpha", "utf8");
    await fs.writeFile(path.join(dir, "MEMORY.md"), "# Handbook", "utf8");
    await fs.writeFile(
      path.join(dir, "memory_summary.md"),
      "# Summary",
      "utf8",
    );
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const list = await store.list();
    expect(list.map((m) => m.name)).toEqual(["alpha"]);
  });

  it("skips corrupt files (does not throw)", async () => {
    const dir = await trackTempDir();
    await fs.writeFile(path.join(dir, "good.md"), "# Good", "utf8");
    await fs.writeFile(path.join(dir, "bad.md"), "not valid", "utf8");
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const list = await store.list();
    // "bad.md" has no `# heading` — the parser falls
    // back to the file name as the title. The file is
    // NOT skipped (a missing title is recoverable).
    // This is the lenient-parser behavior; if it
    // changes to skip, this test breaks intentionally.
    expect(list.map((m) => m.name).sort()).toEqual(["bad", "good"]);
  });
});

describe("LocalMemoryStore.read", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await trackTempDir();
  });

  it("returns undefined for a missing name", async () => {
    const store = new LocalMemoryStore({ memoryRoot: dir });
    expect(await store.read("nope")).toBeUndefined();
  });

  it("returns the parsed body for an existing memory", async () => {
    await fs.writeFile(
      path.join(dir, "foo.md"),
      "---\ntags: [a, b]\ncreated: 2026-08-21\n---\n\n# Foo\n\nThe body.",
      "utf8",
    );
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const mem = await store.read("foo");
    expect(mem).toEqual({
      name: "foo",
      title: "Foo",
      tags: ["a", "b"],
      created: "2026-08-21",
      body: "The body.",
    });
  });

  it("returns undefined for a reserved name", async () => {
    await fs.writeFile(path.join(dir, "MEMORY.md"), "# Handbook", "utf8");
    const store = new LocalMemoryStore({ memoryRoot: dir });
    expect(await store.read("MEMORY")).toBeUndefined();
  });

  it("returns undefined for an invalid name", async () => {
    const store = new LocalMemoryStore({ memoryRoot: dir });
    expect(await store.read("UPPER")).toBeUndefined();
    expect(await store.read("with space")).toBeUndefined();
  });
});

describe("LocalMemoryStore.write", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await trackTempDir();
  });

  it("writes a new memory and returns its metadata", async () => {
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const meta = await store.write({
      name: "new",
      title: "New Memory",
      tags: ["test"],
      created: "2026-08-21",
      body: "The body.",
    });
    expect(meta.name).toBe("new");
    expect(meta.title).toBe("New Memory");
    // The file is on disk.
    const onDisk = await fs.readFile(path.join(dir, "new.md"), "utf8");
    expect(onDisk).toContain("# New Memory");
  });

  it("overwrites an existing memory", async () => {
    const store = new LocalMemoryStore({ memoryRoot: dir });
    await store.write({
      name: "x",
      title: "First",
      tags: [],
      created: "unknown",
      body: "first",
    });
    await store.write({
      name: "x",
      title: "Second",
      tags: [],
      created: "unknown",
      body: "second",
    });
    const mem = await store.read("x");
    expect(mem?.title).toBe("Second");
    expect(mem?.body).toBe("second");
  });

  it("rejects invalid names", async () => {
    const store = new LocalMemoryStore({ memoryRoot: dir });
    await expect(
      store.write({
        name: "UPPER",
        title: "T",
        tags: [],
        created: "unknown",
        body: "",
      }),
    ).rejects.toThrow(/invalid memory name/);
    await expect(
      store.write({
        name: "with space",
        title: "T",
        tags: [],
        created: "unknown",
        body: "",
      }),
    ).rejects.toThrow(/invalid memory name/);
  });

  it("rejects reserved names", async () => {
    const store = new LocalMemoryStore({ memoryRoot: dir });
    await expect(
      store.write({
        name: "MEMORY",
        title: "T",
        tags: [],
        created: "unknown",
        body: "",
      }),
    ).rejects.toThrow(/reserved memory name/);
  });
});

// ---------------------------------------------------------------------------
// File format parser + serializer
// ---------------------------------------------------------------------------

describe("parseMemoryFile", () => {
  it("parses a memory with frontmatter", () => {
    const raw = `---
tags: [typescript, harness]
created: 2026-08-21
---

# Title

The body.`;
    const mem = parseMemoryFile("foo", raw);
    expect(mem).toEqual({
      name: "foo",
      title: "Title",
      tags: ["typescript", "harness"],
      created: "2026-08-21",
      body: "The body.",
    });
  });

  it("parses a memory without frontmatter", () => {
    const raw = `# Title

The body.`;
    const mem = parseMemoryFile("foo", raw);
    expect(mem).toEqual({
      name: "foo",
      title: "Title",
      tags: [],
      created: "unknown",
      body: "The body.",
    });
  });

  it("falls back to the file name when no H1 is present", () => {
    const raw = `No heading here, just text.`;
    const mem = parseMemoryFile("fallback", raw);
    expect(mem.title).toBe("fallback");
  });

  it("preserves H2+ subsections in the body", () => {
    const raw = `# Title

Intro.

## Section A

Body of A.

## Section B

Body of B.`;
    const mem = parseMemoryFile("foo", raw);
    expect(mem.title).toBe("Title");
    expect(mem.body).toContain("## Section A");
    expect(mem.body).toContain("## Section B");
  });
});

describe("serializeMemoryFile + parseMemoryFile round-trip", () => {
  it("round-trips a memory with frontmatter", () => {
    const mem = {
      name: "foo",
      title: "Foo",
      tags: ["a", "b"],
      created: "2026-08-21",
      body: "Body.",
    };
    const raw = serializeMemoryFile(mem);
    const parsed = parseMemoryFile("foo", raw);
    expect(parsed).toEqual(mem);
  });

  it("round-trips a memory without frontmatter (no tags, unknown created)", () => {
    const mem = {
      name: "foo",
      title: "Foo",
      tags: [],
      created: "unknown",
      body: "Body.",
    };
    const raw = serializeMemoryFile(mem);
    const parsed = parseMemoryFile("foo", raw);
    expect(parsed).toEqual(mem);
  });
});
