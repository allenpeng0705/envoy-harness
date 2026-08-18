/**
 * Scoreboard file I/O (§13 of the design).
 *
 * **Format:** YAML. The scoreboard is a list of entries;
 * each entry is the shape defined in `types.ts`. The file
 * is round-trip-stable: read → write produces identical
 * content (modulo whitespace, which is normalized on write).
 *
 * **Atomic writes:** every write goes through a temp file
 * + rename. A crash mid-write leaves the previous scoreboard
 * intact. (A crash mid-read is impossible — read is
 * synchronous until the buffer is in memory.)
 *
 * **Why a separate module from types?** The types are pure
 * data; the file I/O is impure. Keeping them apart means
 * tests can construct scoreboards without touching disk.
 *
 * **Stability:** the on-disk format is YAML with the
 * `ScoreboardEntry` shape. New optional fields are additive;
 * renaming existing fields is a major version bump.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  BenchmarkSchema,
  ScoreboardEntrySchema,
  ScoreboardSchema,
  type Benchmark,
  type Scoreboard,
  type ScoreboardEntry,
} from "./types.js";

/**
 * Read the scoreboard from a file. Returns an empty scoreboard
 * if the file doesn't exist (a fresh peer has no history).
 * Throws if the file exists but is malformed — the user
 * should fix it manually, not have us silently drop entries.
 */
export async function readScoreboard(filePath: string): Promise<Scoreboard> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = parseYaml(raw);
  return ScoreboardSchema.parse(parsed);
}

/**
 * Append a new entry to the scoreboard. Atomic write via
 * temp + rename. The file is created if it doesn't exist.
 */
export async function appendEntry(
  filePath: string,
  entry: ScoreboardEntry,
): Promise<void> {
  // Validate before write.
  const validated = ScoreboardEntrySchema.parse(entry);
  const existing = await readScoreboard(filePath);
  existing.push(validated);
  await writeScoreboard(filePath, existing);
}

/**
 * Write the whole scoreboard, atomically. Used by
 * `appendEntry` after appending. Exposed publicly for
 * tests and for cases where the caller wants a clean write.
 */
export async function writeScoreboard(
  filePath: string,
  scoreboard: Scoreboard,
): Promise<void> {
  const validated = ScoreboardSchema.parse(scoreboard);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, stringifyYaml(validated), "utf8");
  await fs.rename(tmp, filePath);
}

/**
 * Read a benchmark from a YAML file. Throws on missing or
 * malformed. The benchmark is FROZEN — a peer's benchmark
 * file should not be edited during a cycle.
 */
export async function readBenchmark(filePath: string): Promise<Benchmark> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = parseYaml(raw);
  return BenchmarkSchema.parse(parsed);
}

/**
 * Write a benchmark to YAML. Used by tests to materialize
 * fixtures. Production code never writes the benchmark —
 * it's frozen by the operator.
 */
export async function writeBenchmark(
  filePath: string,
  benchmark: Benchmark,
): Promise<void> {
  const validated = BenchmarkSchema.parse(benchmark);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, stringifyYaml(validated), "utf8");
  await fs.rename(tmp, filePath);
}

/**
 * Hash a VerifierRuleset. The hash is a SHA-256 of the
 * canonicalized list of (name + summary) pairs.
 *
 * **Why name + summary, not the full function?** Functions
 * aren't serializable. The hash is a stable identifier for
 * "this is ruleset version X" — what changes between cycles
 * is the set of rule names (and their descriptions), not the
 * internal logic (which is in TypeScript code, not data).
 */
export async function hashRuleset(
  rules: ReadonlyArray<{ name: string; description?: string | undefined }>,
): Promise<string> {
  const { createHash } = await import("node:crypto");
  const canonical = rules
    .map((r) => `${r.name}:${r.description ?? ""}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Sign the canonical payload of a scoreboard entry. v0:
 * SHA-256 of the JSON-serialized fields minus the
 * `ownerSignature` itself. Phase 2+ replaces this with
 * Ed25519 via the owner's key.
 */
export async function signEntry(
  entry: Omit<ScoreboardEntry, "ownerSignature">,
): Promise<string> {
  const { createHash } = await import("node:crypto");
  const canonical = JSON.stringify({
    version: entry.version,
    hypothesis: entry.hypothesis,
    rulesetHash: entry.rulesetHash,
    meanScore: entry.meanScore,
    passRateBefore: entry.passRateBefore,
    passRateAfter: entry.passRateAfter,
    nRuns: entry.nRuns,
    status: entry.status,
    createdAt: entry.createdAt,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
