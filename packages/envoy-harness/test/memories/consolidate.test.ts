/**
 * Tests for `src/memories/consolidate.ts` — session-end
 * memory consolidation.
 *
 * Covers:
 * 1. Empty candidate list → { added: [] }.
 * 2. Two new candidates → both added + written.
 * 3. A candidate whose hash matches an existing
 *    memory → dedup, not written.
 * 4. Invalid name → in `rejected`, not `added`.
 * 5. The LLM `extract` function throws → bubbles up
 *    (caller catches and degrades).
 *
 * **Hermetic:** uses a temp dir + `LocalMemoryStore`
 * + fake `extract` functions.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { consolidateMemories, hashMemoryBody } from "../../src/memories/consolidate.js";
import { LocalMemoryStore, type Memory } from "../../src/memories/store.js";

const tempDirs: string[] = [];

async function trackTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "envoy-cons-test-"));
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

function makeMemory(name: string, body: string): Memory {
  return {
    name,
    title: `Title for ${name}`,
    tags: [],
    created: "2026-08-21",
    body,
  };
}

describe("hashMemoryBody", () => {
  it("is deterministic", () => {
    const mem = makeMemory("a", "hello world");
    expect(hashMemoryBody(mem)).toBe(hashMemoryBody(mem));
  });

  it("normalizes whitespace", () => {
    const a = makeMemory("a", "hello   world");
    const b = makeMemory("b", "hello world");
    // Different names but identical normalized bodies.
    // For dedup, the hash depends on the body, not the
    // name. So a and b have the same hash.
    expect(hashMemoryBody(a)).toBe(hashMemoryBody(b));
  });

  it("differs for different bodies", () => {
    const a = makeMemory("a", "hello");
    const b = makeMemory("b", "world");
    expect(hashMemoryBody(a)).not.toBe(hashMemoryBody(b));
  });
});

describe("consolidateMemories", () => {
  it("returns { added: [] } for an empty candidate list", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const r = await consolidateMemories(store, [], {
      extract: async () => [],
    });
    expect(r.added).toEqual([]);
    expect(r.duplicates).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it("writes 2 new candidates", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const r = await consolidateMemories(store, [], {
      extract: async () => [
        makeMemory("a", "body a"),
        makeMemory("b", "body b"),
      ],
    });
    expect(r.added).toHaveLength(2);
    expect(r.duplicates).toHaveLength(0);
    // Both are on disk.
    expect(await store.read("a")).toBeDefined();
    expect(await store.read("b")).toBeDefined();
  });

  it("dedups candidates whose body hash matches an existing memory", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    // Pre-seed a memory.
    await store.write(makeMemory("existing", "the body"));
    // Re-running consolidation with the same body
    // should NOT add a new memory.
    const r = await consolidateMemories(store, [], {
      extract: async () => [makeMemory("new-name", "the body")],
    });
    expect(r.added).toEqual([]);
    expect(r.duplicates).toHaveLength(1);
    // The original memory is untouched.
    expect(await store.read("existing")).toBeDefined();
    // The duplicate was NOT written.
    expect(await store.read("new-name")).toBeUndefined();
  });

  it("rejects candidates with invalid names", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const r = await consolidateMemories(store, [], {
      extract: async () => [
        makeMemory("Valid", "body"),
        makeMemory("with space", "body"),
      ],
    });
    expect(r.added).toEqual([]);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0]?.reason).toMatch(/invalid/);
  });

  it("rejects candidates with missing name or title", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const bad: Memory = {
      name: "",
      title: "T",
      tags: [],
      created: "unknown",
      body: "b",
    };
    const r = await consolidateMemories(store, [], {
      extract: async () => [bad],
    });
    expect(r.added).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toMatch(/missing name/);
  });

  it("persists the hash store so re-runs dedup against the prior state", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    // First run: write one memory.
    await consolidateMemories(store, [], {
      extract: async () => [makeMemory("a", "body a")],
    });
    // Second run: a fresh store (simulating a new
    // session) should still dedup because the hash
    // file persists.
    const store2 = new LocalMemoryStore({ memoryRoot: dir });
    const r = await consolidateMemories(store2, [], {
      extract: async () => [makeMemory("a", "body a")],
    });
    expect(r.added).toEqual([]);
    expect(r.duplicates).toHaveLength(1);
  });

  it("lets the LLM `extract` throw bubble up (caller catches)", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    await expect(
      consolidateMemories(store, [], {
        extract: async () => {
          throw new Error("LLM unavailable");
        },
      }),
    ).rejects.toThrow(/LLM unavailable/);
  });
});
