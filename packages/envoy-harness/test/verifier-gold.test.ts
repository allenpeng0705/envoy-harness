/**
 * Gold-output comparison — the deterministic, model-free half of the
 * benchmark criterion.
 *
 * **Why this exists.** `BenchmarkTaskSchema.goldOutput` was declared from
 * the start and never read (its own comment said "v0: ignored"), so the
 * only question the benchmark could ask was "does the verifier pass this
 * stub?" — never "does the output match what was wanted?". Adding it makes
 * output correctness expressible without an agent or a model in the loop.
 *
 * **The design point these tests pin.** Gold agreement is a FIXED term of
 * the criterion, deliberately *not* one of the selectable rules. If it were
 * a rule, the self-evolution loop could deselect it — and a criterion the
 * optimiser is allowed to delete is not a criterion.
 */

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_RULES,
  DefaultBenchmarkRunner,
  matchesGold,
  normalizeForGold,
  readBenchmark,
  type AgentResult,
  type Benchmark,
} from "../src/index.js";
import { removeTempDir } from "./support/tmp-dir.js";

function result(text: string): AgentResult {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    iterations: 1,
    toolCalls: 0,
    messages: [],
    sandboxPolicy: {
      mode: "workspace-write",
      approval: "on-request",
      backend: "none",
      writableRoots: ["/tmp"],
      networkAccess: false,
      slashTmpWritable: true,
    },
    metrics: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

describe("normalizeForGold", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeForGold("  a   b \n c ")).toBe("a b c");
  });

  it("preserves case — a gold output is an exact artifact", () => {
    expect(normalizeForGold("Deploy")).not.toBe(normalizeForGold("deploy"));
  });
});

describe("matchesGold", () => {
  it("is undefined when the task declares no gold", () => {
    expect(matchesGold(result("anything"), undefined)).toBeUndefined();
  });

  it("matches despite whitespace differences", () => {
    expect(matchesGold(result("deploy  the\nmigration"), "deploy the migration")).toBe(true);
  });

  it("does not match different text", () => {
    expect(matchesGold(result("something else"), "deploy the migration")).toBe(false);
  });

  it("does not match a prefix (gold is the whole output)", () => {
    expect(matchesGold(result("deploy the migration and more"), "deploy the migration")).toBe(false);
  });
});

async function benchWith(tasks: Benchmark["tasks"]): Promise<Benchmark> {
  return { name: "gold-test", tasks };
}

describe("DefaultBenchmarkRunner uses gold as a fixed term", () => {
  it("a task with no gold behaves exactly as before", async () => {
    const runner = new DefaultBenchmarkRunner();
    const bench = await benchWith([
      { id: "t1", objective: "deploy the database", stubKind: "ok" },
    ]);
    const r = await runner.run(DEFAULT_RULES, bench);
    expect(r.tasks[0]).toEqual({ id: "t1", pass: true });
    expect(r.passRate).toBe(1);
  });

  it("passes when the output matches gold", async () => {
    const runner = new DefaultBenchmarkRunner();
    // The `ok` stub produces exactly `completed: <objective>`.
    const bench = await benchWith([
      {
        id: "t1",
        objective: "deploy the database",
        stubKind: "ok",
        goldOutput: "completed: deploy the database",
      },
    ]);
    const r = await runner.run(DEFAULT_RULES, bench);
    expect(r.tasks[0]).toEqual({ id: "t1", pass: true, gold: "match" });
  });

  it("REJECTS a task whose output does not match gold, even when the verifier passes", async () => {
    const runner = new DefaultBenchmarkRunner();
    const bench = await benchWith([
      {
        id: "t1",
        objective: "deploy the database",
        stubKind: "ok",
        // Correct behaviour per the verifier, wrong output per the spec.
        goldOutput: "something entirely different",
      },
    ]);
    const r = await runner.run(DEFAULT_RULES, bench);
    // This is the whole point: the verifier passing is not sufficient when
    // the benchmark states what the output should have been.
    expect(r.tasks[0]).toEqual({ id: "t1", pass: false, gold: "mismatch" });
    expect(r.passRate).toBe(0);
  });

  it("gold is NOT deselectable by the ruleset", async () => {
    // An empty ruleset still cannot make a gold mismatch pass.
    const runner = new DefaultBenchmarkRunner();
    const bench = await benchWith([
      {
        id: "t1",
        objective: "deploy the database",
        stubKind: "ok",
        goldOutput: "something entirely different",
      },
    ]);
    const r = await runner.run([], bench);
    expect(r.tasks[0]?.pass).toBe(false);
    expect(r.tasks[0]?.gold).toBe("mismatch");
  });

  it("reports the gold diagnostic only when a task declares gold", async () => {
    const runner = new DefaultBenchmarkRunner();
    const bench = await benchWith([
      { id: "no-gold", objective: "deploy the database", stubKind: "ok" },
      {
        id: "with-gold",
        objective: "deploy the database",
        stubKind: "ok",
        goldOutput: "completed: deploy the database",
      },
    ]);
    const r = await runner.run(DEFAULT_RULES, bench);
    expect(r.tasks.find((t) => t.id === "no-gold")?.gold).toBeUndefined();
    expect(r.tasks.find((t) => t.id === "with-gold")?.gold).toBe("match");
  });
});

describe("goldOutput survives the YAML round-trip", () => {
  it("is parsed from a benchmark file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "envoy-gold-"));
    try {
      const file = path.join(dir, "b.yaml");
      await fs.writeFile(
        file,
        `name: gold-roundtrip
tasks:
  - id: t1
    objective: deploy the database
    stubKind: ok
    goldOutput: "completed: deploy the database"
`,
        "utf8",
      );
      const bench = await readBenchmark(file);
      expect(bench.tasks[0]?.goldOutput).toBe("completed: deploy the database");
      const r = await new DefaultBenchmarkRunner().run(DEFAULT_RULES, bench);
      expect(r.passRate).toBe(1);
    } finally {
      await removeTempDir(dir);
    }
  });
});
