/**
 * Tests for `src/memories/inject.ts` — bounded
 * memory fragments.
 *
 * Covers:
 * 1. `buildMemoryIndex` returns a single fragment
 *    for a non-empty store.
 * 2. `buildMemoryIndex` returns `[]` for an empty
 *    store.
 * 3. The fragment's `render()` is stable + parseable.
 * 4. `buildIndexFragment` from a pre-fetched list
 *    (no I/O) gives the same shape.
 * 5. `buildMemoryFragment` returns a single fragment
 *    for one memory; the fragment's `render()`
 *    includes the title + body.
 *
 * **Hermetic:** uses a temp dir + `LocalMemoryStore`.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildIndexFragment,
  buildMemoryFragment,
  buildMemoryIndex,
} from "../../src/memories/inject.js";
import { LocalMemoryStore } from "../../src/memories/store.js";

const tempDirs: string[] = [];

async function trackTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "envoy-inject-test-"));
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

describe("buildMemoryIndex", () => {
  it("returns [] for an empty store", async () => {
    const dir = await trackTempDir();
    const store = new LocalMemoryStore({ memoryRoot: dir });
    expect(await buildMemoryIndex(store)).toEqual([]);
  });

  it("returns a single fragment for a non-empty store", async () => {
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
    const store = new LocalMemoryStore({ memoryRoot: dir });
    const fragments = await buildMemoryIndex(store);
    expect(fragments).toHaveLength(1);
    const f = fragments[0]!;
    expect(f.id).toBe("memory-index");
    expect(f.owner).toBe("memory-index");
    expect(f.priority).toBe(-100);
    expect(f.estimatedTokens).toBeGreaterThan(0);
    // The rendered text includes both memory titles.
    const text = f.render();
    expect(text).toContain("alpha");
    expect(text).toContain("Alpha");
    expect(text).toContain("bravo");
    expect(text).toContain("Bravo");
    expect(text).toContain("typescript");
  });
});

describe("buildIndexFragment (pre-fetched list)", () => {
  it("produces a stable + parseable index from a MemoryMeta list", () => {
    const list = [
      {
        name: "alpha",
        path: "/x/alpha.md",
        title: "Alpha",
        tags: ["a"],
        created: "2026-08-21",
        estimatedTokens: 5,
      },
      {
        name: "bravo",
        path: "/x/bravo.md",
        title: "Bravo",
        tags: [],
        created: "unknown",
        estimatedTokens: 5,
      },
    ];
    const f = buildIndexFragment(list);
    const text = f.render();
    expect(text).toMatch(/Available memories/);
    expect(text).toMatch(/- \[alpha\]/);
    expect(text).toMatch(/- \[bravo\]/);
    // Tags are shown for `alpha` (it has tags) but
    // not for `bravo` (empty tags).
    expect(text).toMatch(/\[a\]/);
  });
});

describe("buildMemoryFragment (single memory)", () => {
  it("returns a single fragment for a memory", () => {
    const f = buildMemoryFragment({
      name: "alpha",
      title: "Alpha",
      tags: ["a"],
      created: "2026-08-21",
      body: "The body.",
    });
    expect(f.id).toBe("memory:alpha");
    expect(f.owner).toBe("memory:alpha");
    expect(f.priority).toBe(100);
    const text = f.render();
    expect(text).toContain("# Memory: alpha");
    expect(text).toContain("Title: Alpha");
    expect(text).toContain("Tags: a");
    expect(text).toContain("The body.");
  });

  it("omits the Tags / Created lines when not set", () => {
    const f = buildMemoryFragment({
      name: "x",
      title: "X",
      tags: [],
      created: "unknown",
      body: "Body.",
    });
    const text = f.render();
    expect(text).not.toContain("Tags:");
    expect(text).not.toContain("Created:");
  });
});
