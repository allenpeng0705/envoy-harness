/**
 * SelfEvolve — the 5-step protocol (§13 of the design).
 *
 * **The 5 steps:**
 *
 * 1. **SNAPSHOT** — copy the current state (ruleset, scoreboard,
 *    AGENTS.md) into a versioned directory. The snapshot is the
 *    rollback target; a `reverted` entry leaves the snapshot
 *    untouched.
 *
 * 2. **HYPOTHESIZE** — the `HypothesisProvider` (a model, by
 *    default; a stub in tests) reads the recent failures from
 *    the scoreboard and proposes a new ruleset. The proposal is
 *    a FULL ruleset, not a patch — the protocol never operates
 *    on the live state.
 *
 * 3. **CANDIDATE** — write the proposed ruleset to
 *    `v<version>.candidate.json`. The candidate is immutable
 *    once written; if the cycle reverts, the live ruleset is
 *    unchanged.
 *
 * 4. **EVALUATE** — run the benchmark against both the current
 *    ruleset (baseline) and the candidate. The protocol keeps
 *    the candidate iff `candidate.passRate > baseline.passRate`
 *    (strict greater; ties are reverting to be conservative).
 *
 * 5. **COMMIT / REVERT** — append a `ScoreboardEntry` to the
 *    scoreboard (the audit trail). If kept, copy the candidate
 *    over the live ruleset. If reverted, do nothing (the
 *    snapshot is the rollback target if a future cycle needs
 *    it).
 *
 * **Shadow mode:** the protocol can run without committing
 * changes. The scoreboard entry is still written (the entry's
 * `status: 'kept'` or `'reverted'` reflects what WOULD have
 * happened, not what did). This is how v0 lands: the operator
 * inspects the scoreboard to decide whether to enable
 * committing.
 *
 * **Contamination guard:** the hypothesis prompt is assembled
 * by `buildHypothesisPrompt`, which is tested explicitly to
 * confirm it does NOT include the benchmark or any private
 * data. The guard is enforced by the API — the prompt builder
 * is the only path to the model.
 *
 * **Stability:** the public API is `runOneCycle`, `snapshot`,
 * `proposeHypothesis`, `runBenchmark`, `commitCandidate`. All
 * are stable; new ones are additive.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  hashRuleset,
  readScoreboard,
  signEntry,
  type Benchmark,
  type BenchmarkResult,
  type Scoreboard,
  type ScoreboardEntry,
} from "./index.js";
import { combineVerdicts, runVerifierRules, type VerifierRule } from "../verifier/index.js";
import type { AgentResult, ModelAdapter, ModelResponse } from "../index.js";

// ---------------------------------------------------------------------------
// External roles
// ---------------------------------------------------------------------------

/** The paths SelfEvolve reads / writes. All under one peer dir. */
export interface SelfEvolvePaths {
  /** `~/.envoymesh/agent-state/<peer>/verifier-scoreboard.yaml` */
  scoreboard: string;
  /** `~/.envoymesh/agent-state/<peer>/snapshots/` */
  snapshotDir: string;
  /** `~/.envoymesh/agent-state/<peer>/benchmarks/<name>/frozen.yaml` */
  benchmark: string;
  /**
   * The current ruleset (read for snapshotting; written on commit).
   * v0: the ruleset lives in code (DEFAULT_RULES) and the file
   * is just a snapshot. Phase 2 makes this a real editable file.
   */
  ruleset: string;
  /** The user's AGENTS.md. v0: snapshotted, not edited. */
  agentsMd: string;
}

/**
 * The hypothesis provider. In production, this is a model
 * adapter wrapped in a prompt. In tests, it's a stub that
 * returns a predetermined ruleset.
 *
 * **The contamination guard is enforced here:** the input
 * to `proposeHypothesis` must NOT contain the benchmark or
 * any private data. The provider's prompt assembly is the
 * only place that sees both the scoreboard and the current
 * ruleset; the benchmark is never in that scope.
 */
export interface HypothesisProvider {
  proposeHypothesis(input: {
    currentRules: ReadonlyArray<VerifierRule>;
    recentFailures: ReadonlyArray<ScoreboardEntry>;
  }): Promise<Hypothesis | null>;
}

/** A hypothesis is a full new ruleset (not a patch). */
export interface Hypothesis {
  text: string;
  ruleChanges: VerifierRule[];
}

/**
 * The benchmark runner. Decoupled from the protocol so tests
 * can supply a stub that returns a predetermined pass rate.
 */
export interface BenchmarkRunner {
  run(
    rules: ReadonlyArray<VerifierRule>,
    benchmark: Benchmark,
  ): Promise<BenchmarkResult>;
}

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

/**
 * A model-backed `HypothesisProvider`. The model receives the
 * prompt built by `buildHypothesisPrompt` (the contamination
 * guard) and returns a JSON-serialized hypothesis.
 *
 * **Why JSON output?** Easier to parse than free-form text.
 * The model is told to return a specific shape; failures
 * to parse are caught and treated as "no actionable hypothesis".
 */
export class ModelHypothesisProvider implements HypothesisProvider {
  constructor(private model: ModelAdapter) {}
  async proposeHypothesis(input: {
    currentRules: ReadonlyArray<VerifierRule>;
    recentFailures: ReadonlyArray<ScoreboardEntry>;
  }): Promise<Hypothesis | null> {
    const prompt = buildHypothesisPrompt(input);
    const response = await this.model.complete({
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ],
      tools: [],
    });
    return parseHypothesisFromLlm(response);
  }
}

/**
 * Build the hypothesis prompt. **This is the contamination
 * guard.** The function is `export`ed specifically so the
 * test in 5d can assert that the prompt does not contain
 * the benchmark or any private data.
 *
 * **Safe inputs only:** the function takes only the current
 * ruleset (names + descriptions) and the recent scoreboard
 * entries. It does NOT take the benchmark; even if a caller
 * passes the benchmark, the prompt builder will silently
 * drop it.
 */
export function buildHypothesisPrompt(input: {
  currentRules: ReadonlyArray<VerifierRule>;
  recentFailures: ReadonlyArray<ScoreboardEntry>;
}): string {
  const rulesJson = JSON.stringify(
    input.currentRules.map((r) => ({ name: r.name, description: r.description })),
    null,
    2,
  );
  const failuresJson = JSON.stringify(
    input.recentFailures.map((f) => ({
      version: f.version,
      hypothesis: f.hypothesis,
      status: f.status,
      passRateBefore: f.passRateBefore,
      passRateAfter: f.passRateAfter,
    })),
    null,
    2,
  );
  return `You are the self-evolution optimizer for envoy-harness.

# Current ruleset
${rulesJson}

# Recent scoreboard entries
${failuresJson}

# Task
Propose ONE specific, falsifiable change to the ruleset that would catch more
of the failures above. Be conservative: small, targeted changes only.

Output JSON only, in this exact shape:
{ "text": "<one-sentence hypothesis>", "ruleChanges": [ <full new ruleset> ] }

Constraints:
- ruleChanges is a FULL new ruleset, not a patch.
- Each rule has { name, description, check } — but you only need to provide
  name and description; the implementation is in TypeScript.
- If you cannot propose a meaningful change, output { "text": "no actionable
  hypothesis", "ruleChanges": [] } and the cycle will be recorded as a no-op.`;
}

/** Parse the model's response into a Hypothesis. Tolerant of bad shape. */
export function parseHypothesisFromLlm(response: ModelResponse): Hypothesis | null {
  // Concatenate all text blocks.
  const text = response.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  // Find the JSON object in the text (defensive against leading / trailing prose).
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed.text !== "string") return null;
    if (!Array.isArray(parsed.ruleChanges)) return null;
    if (parsed.ruleChanges.length === 0) {
      // Explicit "no actionable hypothesis".
      return null;
    }
    // Validate each rule has at least name and description.
    const rules: VerifierRule[] = parsed.ruleChanges.map((r: unknown) => {
      if (typeof r !== "object" || r === null) {
        throw new Error("rule must be an object");
      }
      const obj = r as { name?: unknown; description?: unknown };
      if (typeof obj.name !== "string" || typeof obj.description !== "string") {
        throw new Error("rule must have name and description");
      }
      // The model can't provide a real `check` function; the
      // caller is expected to keep the implementation from
      // the original rule and merge by name.
      return {
        name: obj.name,
        description: obj.description,
        // Placeholder: a real cycle would carry the original
        // rule's `check` function by name. The test provider
        // does this explicitly.
        async check() {
          return { kind: "pass" as const, score: 1.0, confidence: "low" as const };
        },
      };
    });
    return { text: parsed.text, ruleChanges: rules };
  } catch {
    return null;
  }
}

/**
 * The default benchmark runner. Loads each task's `stubKind`
 * and constructs an `AgentResult` from the corresponding
 * stub. v0: stubs are inline; Phase 2 can run real worker
 * loops for the benchmark.
 *
 * **Why stubs, not real workers?** A benchmark is supposed
 * to be FAST and DETERMINISTIC. A real worker is slow and
 * non-deterministic (model temperature, network, etc.).
 * Stubs give the same input each cycle so pass rates are
 * comparable.
 */
export class DefaultBenchmarkRunner implements BenchmarkRunner {
  async run(
    rules: ReadonlyArray<VerifierRule>,
    benchmark: Benchmark,
  ): Promise<BenchmarkResult> {
    const results: Array<{ id: string; pass: boolean }> = [];
    for (const task of benchmark.tasks) {
      const result = buildStubResult(task);
      const verdicts = await runVerifierRules(result, task.objective, rules);
      const combined = combineVerdicts(verdicts);
      // Pass = verdict.kind === 'pass' AND (no expectedVerdict OR
      // verdict.kind === expectedVerdict). For negative tests
      // (expectedVerdict: 'fail'), the candidate must FAIL.
      const pass = task.expectedVerdict
        ? combined.kind === task.expectedVerdict
        : combined.kind === "pass";
      results.push({ id: task.id, pass });
    }
    const passed = results.filter((r) => r.pass).length;
    return {
      passRate: results.length === 0 ? 0 : passed / results.length,
      meanScore: results.length === 0 ? 0 : passed / results.length,
      nRuns: results.length,
      tasks: results,
    };
  }
}

/** Build an `AgentResult` from a `BenchmarkTask.stubKind`. */
function buildStubResult(task: {
  id: string;
  objective: string;
  stubKind: "empty" | "ok" | "off-topic" | "forbidden-path";
}): AgentResult {
  switch (task.stubKind) {
    case "empty":
      return {
        content: [],
        stopReason: "end_turn",
        iterations: 1,
        toolCalls: 0,
        messages: [],
        sandboxPolicy: {
          mode: "workspace-write",
          approval: "on-request",
          backend: "linux-landlock",
          writableRoots: ["/tmp"],
          networkAccess: false,
          excludeSlashTmp: true,
        },
      };
    case "ok":
      return {
        content: [
          { type: "text", text: `deployed the ${task.objective.split(" ")[0] ?? "thing"} successfully` },
        ],
        stopReason: "end_turn",
        iterations: 1,
        toolCalls: 0,
        messages: [],
        sandboxPolicy: {
          mode: "workspace-write",
          approval: "on-request",
          backend: "linux-landlock",
          writableRoots: ["/tmp"],
          networkAccess: false,
          excludeSlashTmp: true,
        },
      };
    case "off-topic":
      return {
        content: [{ type: "text", text: "completely unrelated content" }],
        stopReason: "end_turn",
        iterations: 1,
        toolCalls: 0,
        messages: [],
        sandboxPolicy: {
          mode: "workspace-write",
          approval: "on-request",
          backend: "linux-landlock",
          writableRoots: ["/tmp"],
          networkAccess: false,
          excludeSlashTmp: true,
        },
      };
    case "forbidden-path":
      return {
        content: [{ type: "text", text: "wrote to /etc/passwd" }],
        stopReason: "end_turn",
        iterations: 1,
        toolCalls: 0,
        messages: [],
        sandboxPolicy: {
          mode: "workspace-write",
          approval: "on-request",
          backend: "linux-landlock",
          writableRoots: ["/tmp"],
          networkAccess: false,
          excludeSlashTmp: true,
        },
      };
  }
}

// ---------------------------------------------------------------------------
// SelfEvolve
// ---------------------------------------------------------------------------

export interface SelfEvolveOptions {
  /** Snapshot + commit target. */
  paths: SelfEvolvePaths;
  /** The current ruleset. v0: `DEFAULT_RULES` from the verifier module. */
  currentRules: ReadonlyArray<VerifierRule>;
  /** The hypothesis provider. v0: a model adapter via `ModelHypothesisProvider`. */
  hypothesisProvider: HypothesisProvider;
  /** The benchmark runner. v0: `new DefaultBenchmarkRunner()`. */
  benchmarkRunner: BenchmarkRunner;
  /**
   * Shadow mode: never commit, always record. v0 ships in
   * shadow mode by default; production turns this off once
   * the scoreboard history is clean.
   */
  shadowMode?: boolean;
  /**
   * Number of recent failures to feed the hypothesis prompt.
   * Default: 20 (per design §13.1).
   */
  recentFailureWindow?: number;
}

export interface RunOneCycleResult {
  /** Whether the candidate was kept (would have been, in shadow mode). */
  kept: boolean;
  /** The scoreboard entry written by this cycle. */
  entry: ScoreboardEntry;
  /** The benchmark result BEFORE applying the change. */
  before: BenchmarkResult;
  /** The benchmark result AFTER applying the change. */
  after: BenchmarkResult;
}

export class SelfEvolve {
  private paths: SelfEvolvePaths;
  private currentRules: ReadonlyArray<VerifierRule>;
  private hypothesisProvider: HypothesisProvider;
  private benchmarkRunner: BenchmarkRunner;
  private shadowMode: boolean;
  private recentFailureWindow: number;

  constructor(options: SelfEvolveOptions) {
    this.paths = options.paths;
    this.currentRules = options.currentRules;
    this.hypothesisProvider = options.hypothesisProvider;
    this.benchmarkRunner = options.benchmarkRunner;
    this.shadowMode = options.shadowMode ?? true; // default: shadow mode
    this.recentFailureWindow = options.recentFailureWindow ?? 20;
  }

  /**
   * Run one cycle of the 5-step protocol. Returns the result
   * (kept, entry, before, after) and writes a `ScoreboardEntry`
   * to the scoreboard file.
   *
   * **Throws:** if the scoreboard file is malformed. Network
   * / model errors propagate to the caller; the cycle is
   * NOT recorded (a partial cycle shouldn't pollute history).
   */
  async runOneCycle(): Promise<RunOneCycleResult> {
    return this.runOneCycleInner({ externalHypothesis: null });
  }

  /**
   * Run the 5-step protocol with a fixed (external) hypothesis.
   * Used by the federated layer (§13.3) to evaluate a peer's
   * candidate against the local benchmark.
   *
   * **Differs from `runOneCycle` in two ways:**
   *
   * 1. **No provider call.** The hypothesis is given; step 2
   *    (HYPOTHESIZE) is skipped entirely.
   * 2. **Never commits.** Even in non-shadow mode, a federated
   *    cycle does NOT replace the local ruleset. Adoption is
   *    a separate, opt-in step (F6.3 / F6.4).
   *
   * The result is still recorded as a regular `ScoreboardEntry`
   * (the cycle counter advances). The hypothesis text is
   * prefixed with `[federated]` so the audit trail shows the
   * origin.
   */
  async runOneCycleAgainst(
    externalHypothesis: Hypothesis,
  ): Promise<RunOneCycleResult> {
    return this.runOneCycleInner({ externalHypothesis });
  }

  /**
   * The shared inner loop. `externalHypothesis: null` means
   * "ask the provider"; a non-null value means "use this
   * hypothesis and skip the provider call" (federated path).
   */
  private async runOneCycleInner(input: {
    externalHypothesis: Hypothesis | null;
  }): Promise<RunOneCycleResult> {
    // 1. SNAPSHOT
    const version = await this.nextVersion();
    const snapshotPath = path.join(this.paths.snapshotDir, `v${version}.json`);
    await this.snapshot(snapshotPath);

    // 2. HYPOTHESIZE — skip if external hypothesis given.
    let hypothesis: Hypothesis | null = input.externalHypothesis;
    if (hypothesis === null) {
      const recent = await this.recentFailures(this.recentFailureWindow);
      hypothesis = await this.hypothesisProvider.proposeHypothesis({
        currentRules: this.currentRules,
        recentFailures: recent,
      });
      if (!hypothesis) {
        const entry = await this.recordNoOp(version, recent);
        const bench = await readBenchmarkSafe(this.paths.benchmark);
        const before = await this.benchmarkRunner.run(this.currentRules, bench);
        return { kept: false, entry, before, after: before };
      }
    }

    // Tag the hypothesis text for federated cycles so the
    // audit trail shows the origin.
    const hypothesisText =
      input.externalHypothesis !== null
        ? `[federated] ${hypothesis.text}`
        : hypothesis.text;

    // 3. CANDIDATE — write the candidate ruleset.
    const candidatePath = path.join(
      this.paths.snapshotDir,
      `v${version}.candidate.json`,
    );
    await this.writeCandidate(candidatePath, hypothesis.ruleChanges);

    // 4. EVALUATE
    const bench = await readBenchmarkSafe(this.paths.benchmark);
    const before = await this.benchmarkRunner.run(this.currentRules, bench);
    const after = await this.benchmarkRunner.run(hypothesis.ruleChanges, bench);

    // 5. COMMIT / REVERT — federated cycles NEVER commit, even
    //    when the local gate says "kept". Adoption is a separate
    //    step (§13.3).
    const kept = after.passRate > before.passRate;
    const isFederated = input.externalHypothesis !== null;
    if (kept && !this.shadowMode && !isFederated) {
      await this.commitCandidate(hypothesis.ruleChanges);
    }

    const rulesetHash = await hashRuleset(
      hypothesis.ruleChanges.map((r) => ({ name: r.name, description: r.description })),
    );
    const baseEntry = {
      version,
      hypothesis: hypothesisText,
      rulesetHash,
      meanScore: after.meanScore,
      passRateBefore: before.passRate,
      passRateAfter: after.passRate,
      nRuns: after.nRuns,
      status: kept ? ("kept" as const) : ("reverted" as const),
      createdAt: new Date().toISOString(),
    };
    const ownerSignature = await signEntry(baseEntry);
    const entry: ScoreboardEntry = { ...baseEntry, ownerSignature };

    await this.appendEntry(entry);
    return { kept, entry, before, after };
  }

  /** Read the most recent N scoreboard entries. */
  async recentFailures(n: number): Promise<Scoreboard> {
    const board = await readScoreboard(this.paths.scoreboard);
    return board.slice(-n);
  }

  /** Snapshot the current state to `dest`. */
  async snapshot(dest: string): Promise<void> {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const payload = {
      timestamp: new Date().toISOString(),
      rules: this.currentRules.map((r) => ({
        name: r.name,
        description: r.description,
      })),
    };
    await fs.writeFile(dest, JSON.stringify(payload, null, 2), "utf8");
  }

  /** The current version (max + 1, or 1 if empty). */
  async nextVersion(): Promise<number> {
    const board = await readScoreboard(this.paths.scoreboard);
    if (board.length === 0) return 1;
    return Math.max(...board.map((e) => e.version)) + 1;
  }

  /** Commit a candidate ruleset to the live location. */
  async commitCandidate(rules: ReadonlyArray<VerifierRule>): Promise<void> {
    // v0: ruleset is a code artifact; "committing" means writing
    // the candidate to the ruleset path. Phase 2 may swap this
    // for a git commit or a different storage backend.
    await fs.mkdir(path.dirname(this.paths.ruleset), { recursive: true });
    await fs.writeFile(
      this.paths.ruleset,
      JSON.stringify(
        rules.map((r) => ({ name: r.name, description: r.description })),
        null,
        2,
      ),
      "utf8",
    );
  }

  /** Write the candidate to a snapshot file. */
  private async writeCandidate(
    dest: string,
    rules: ReadonlyArray<VerifierRule>,
  ): Promise<void> {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(
      dest,
      JSON.stringify(
        rules.map((r) => ({ name: r.name, description: r.description })),
        null,
        2,
      ),
      "utf8",
    );
  }

  /** Append an entry to the scoreboard. */
  private async appendEntry(entry: ScoreboardEntry): Promise<void> {
    const { appendEntry } = await import("./storage.js");
    await appendEntry(this.paths.scoreboard, entry);
  }

  /** Record a no-op cycle (no actionable hypothesis). */
  private async recordNoOp(
    version: number,
    _recent: Scoreboard,
  ): Promise<ScoreboardEntry> {
    const baseEntry = {
      version,
      hypothesis: "no actionable hypothesis",
      rulesetHash: await hashRuleset(
        this.currentRules.map((r) => ({ name: r.name, description: r.description })),
      ),
      meanScore: 0,
      passRateBefore: 0,
      passRateAfter: 0,
      nRuns: 0,
      status: "reverted" as const,
      createdAt: new Date().toISOString(),
    };
    const ownerSignature = await signEntry(baseEntry);
    const entry: ScoreboardEntry = { ...baseEntry, ownerSignature };
    await this.appendEntry(entry);
    return entry;
  }
}

/** Read a benchmark; if missing, return an empty benchmark (v0 grace). */
async function readBenchmarkSafe(filePath: string): Promise<Benchmark> {
  try {
    const { readBenchmark } = await import("./storage.js");
    return await readBenchmark(filePath);
  } catch {
    return { name: "empty", tasks: [] };
  }
}
