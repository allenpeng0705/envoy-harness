/**
 * Scoreboard tests (§13 of the design, data layer).
 *
 * Covers:
 * 1. Schemas: validation of ScoreboardEntry / BenchmarkTask /
 *    Benchmark.
 * 2. File I/O: read/write/append of scoreboard, atomic write,
 *    empty-file behavior.
 * 3. Benchmark I/O: read/write round-trip.
 * 4. Hashing: hashRuleset is deterministic + order-independent.
 * 5. Signing: signEntry produces a stable hash for the same
 *    payload (and a different hash for a different payload).
 *
 * **Test isolation:** every test uses a fresh temp dir via
 * `fs.mkdtemp`. No shared state.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendEntry,
  hashRuleset,
  readBenchmark,
  readScoreboard,
  signEntry,
  writeBenchmark,
  writeScoreboard,
  type Benchmark,
  type ScoreboardEntry,
} from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-harness-sb-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<ScoreboardEntry> = {}): ScoreboardEntry {
  return {
    version: 1,
    hypothesis: "Add a keyword overlap rule",
    rulesetHash: "abc123",
    meanScore: 0.8,
    passRateBefore: 0.6,
    passRateAfter: 0.7,
    nRuns: 10,
    status: "kept",
    ownerSignature: "sig-xyz",
    createdAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

function makeBenchmark(): Benchmark {
  return {
    name: "smoke",
    tasks: [
      {
        id: "t1",
        objective: "deploy the database",
        stubKind: "ok",
      },
      {
        id: "t2",
        objective: "do something forbidden",
        stubKind: "forbidden-path",
        expectedVerdict: "fail",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

describe("ScoreboardEntrySchema (via appendEntry)", () => {
  it("accepts a valid entry", async () => {
    const file = path.join(tmpDir, "scoreboard.yaml");
    await appendEntry(file, makeEntry());
    const board = await readScoreboard(file);
    expect(board).toHaveLength(1);
    expect(board[0]?.version).toBe(1);
  });

  it("rejects an entry with bad status", async () => {
    const file = path.join(tmpDir, "scoreboard.yaml");
    await expect(
      appendEntry(file, { ...makeEntry(), status: "pending" as never }),
    ).rejects.toThrow();
  });

  it("rejects an entry with non-integer version", async () => {
    const file = path.join(tmpDir, "scoreboard.yaml");
    await expect(
      appendEntry(file, { ...makeEntry(), version: 1.5 }),
    ).rejects.toThrow();
  });

  it("rejects an entry with passRateAfter out of [0, 1]", async () => {
    const file = path.join(tmpDir, "scoreboard.yaml");
    await expect(
      appendEntry(file, { ...makeEntry(), passRateAfter: 1.5 }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

describe("scoreboard file I/O", () => {
  it("returns an empty scoreboard if the file doesn't exist", async () => {
    const file = path.join(tmpDir, "missing.yaml");
    const board = await readScoreboard(file);
    expect(board).toEqual([]);
  });

  it("returns an empty scoreboard for a present-but-empty file", async () => {
    const file = path.join(tmpDir, "empty.yaml");
    await fs.writeFile(file, "", "utf8");
    const board = await readScoreboard(file);
    expect(board).toEqual([]);
  });

  it("appends to an existing scoreboard", async () => {
    const file = path.join(tmpDir, "scoreboard.yaml");
    await appendEntry(file, makeEntry({ version: 1 }));
    await appendEntry(file, makeEntry({ version: 2, hypothesis: "second" }));
    const board = await readScoreboard(file);
    expect(board).toHaveLength(2);
    expect(board[0]?.version).toBe(1);
    expect(board[1]?.version).toBe(2);
  });

  it("writeScoreboard overwrites the existing file", async () => {
    const file = path.join(tmpDir, "scoreboard.yaml");
    await appendEntry(file, makeEntry({ version: 1 }));
    await writeScoreboard(file, [
      makeEntry({ version: 99, hypothesis: "replaced" }),
    ]);
    const board = await readScoreboard(file);
    expect(board).toHaveLength(1);
    expect(board[0]?.version).toBe(99);
  });

  it("creates parent directories as needed", async () => {
    const file = path.join(tmpDir, "deep", "nested", "scoreboard.yaml");
    await appendEntry(file, makeEntry());
    expect(await readScoreboard(file)).toHaveLength(1);
  });
});

describe("benchmark file I/O", () => {
  it("round-trips a benchmark through YAML", async () => {
    const file = path.join(tmpDir, "benchmark.yaml");
    const original = makeBenchmark();
    await writeBenchmark(file, original);
    const loaded = await readBenchmark(file);
    expect(loaded).toEqual(original);
  });

  it("rejects a benchmark with no tasks", async () => {
    const file = path.join(tmpDir, "benchmark.yaml");
    await expect(
      writeBenchmark(file, { name: "empty", tasks: [] }),
    ).rejects.toThrow();
  });

  it("rejects a task with an unknown stubKind", async () => {
    const file = path.join(tmpDir, "benchmark.yaml");
    await expect(
      writeBenchmark(file, {
        name: "bad",
        tasks: [
          {
            id: "t1",
            objective: "x",
            stubKind: "unknown-stub" as never,
          },
        ],
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Hashing and signing
// ---------------------------------------------------------------------------

describe("hashRuleset", () => {
  it("is deterministic for the same input", async () => {
    const rules = [
      { name: "non-empty", description: "a" },
      { name: "sandbox", description: "b" },
    ];
    const h1 = await hashRuleset(rules);
    const h2 = await hashRuleset(rules);
    expect(h1).toBe(h2);
  });

  it("is order-independent (canonical form sorts)", async () => {
    const a = await hashRuleset([
      { name: "x", description: "1" },
      { name: "y", description: "2" },
    ]);
    const b = await hashRuleset([
      { name: "y", description: "2" },
      { name: "x", description: "1" },
    ]);
    expect(a).toBe(b);
  });

  it("differs when a rule is added or removed", async () => {
    const a = await hashRuleset([{ name: "x", description: "1" }]);
    const b = await hashRuleset([
      { name: "x", description: "1" },
      { name: "y", description: "2" },
    ]);
    expect(a).not.toBe(b);
  });
});

describe("signEntry", () => {
  it("is deterministic for the same payload", async () => {
    const entry = makeEntry();
    const { ownerSignature, ...rest } = entry;
    const s1 = await signEntry(rest);
    const s2 = await signEntry(rest);
    expect(s1).toBe(s2);
  });

  it("differs when a field changes", async () => {
    const entry = makeEntry();
    const { ownerSignature, ...rest } = entry;
    const s1 = await signEntry(rest);
    const s2 = await signEntry({ ...rest, status: "reverted" });
    expect(s1).not.toBe(s2);
  });
});
