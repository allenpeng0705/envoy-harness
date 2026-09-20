/**
 * Scoreboard types (§13 of the design).
 *
 * **What is the scoreboard?** A peer-local, append-only log of
 * every self-evolution cycle's outcome. Each entry records what
 * hypothesis was tested, what the pass rate was before and after,
 * and whether the change was kept or reverted.
 *
 * **Why append-only?** The scoreboard is the audit trail. A peer
 * can replay their evolution history by reading the file from
 * the top. Truncation is a separate, explicit operation; cycle
 * writes never delete prior entries.
 *
 * **Why a separate module from `types.ts`?** The scoreboard is
 * specific to self-evolution; keeping it out of the core type
 * file means the core types stay small and don't drag in the
 * YAML / file I/O surface.
 *
 * **YAML, not JSON:** the design specifies `verifier-scoreboard.yaml`.
 * YAML is human-editable, supports comments, and round-trips
 * through git without noise.
 *
 * **Stability:** `ScoreboardEntry` is the on-disk format.
 * Adding optional fields is additive; renaming existing fields
 * is a major version bump.
 */

import { z } from "zod";

import type { VerifierRule } from "../verifier/index.js";
import {
  AskForApprovalSchema,
  PermissionModeSchema,
  SandboxBackendSchema,
} from "../types.js";

// ---------------------------------------------------------------------------
// ScoreboardEntry — the audit-trail record
// ---------------------------------------------------------------------------

/**
 * One cycle's outcome. Written to `verifier-scoreboard.yaml` after
 * every cycle (kept or reverted). The `ownerSignature` is the
 * cryptographic anchor — without it, a malicious process could
 * rewrite the scoreboard.
 *
 * **v0 signature:** a SHA-256 of the canonical JSON payload.
 * Real Ed25519 signing is a follow-up (requires the owner key,
 * which is a separate concern; see `notes/pending/owner-key.md`).
 */
export const ScoreboardEntrySchema = z.object({
  /** Monotonic version. Starts at 1; never resets. */
  version: z.number().int().positive(),
  /** The hypothesis the model proposed, in plain English. */
  hypothesis: z.string().min(1),
  /** SHA-256 hash of the ruleset that was applied for this cycle. */
  rulesetHash: z.string().min(1),
  /** Mean verifier score across the benchmark, in [0, 1]. */
  meanScore: z.number().min(0).max(1),
  /** Pass rate BEFORE applying the change, in [0, 1]. */
  passRateBefore: z.number().min(0).max(1),
  /** Pass rate AFTER applying the change, in [0, 1]. */
  passRateAfter: z.number().min(0).max(1),
  /** Number of benchmark tasks run. */
  nRuns: z.number().int().nonnegative(),
  /** Whether the candidate was adopted or rolled back. */
  status: z.enum(["kept", "reverted"]),
  /** Cryptographic anchor. v0: SHA-256 hash. Phase 2+: Ed25519. */
  ownerSignature: z.string().min(1),
  /** ISO 8601 timestamp. */
  createdAt: z.string().datetime(),
});
export type ScoreboardEntry = z.infer<typeof ScoreboardEntrySchema>;

/** The whole scoreboard is a list of entries. */
export const ScoreboardSchema = z.array(ScoreboardEntrySchema);
export type Scoreboard = z.infer<typeof ScoreboardSchema>;

// ---------------------------------------------------------------------------
// FederatedAdoptionRecord — the audit trail of federated pulls (§13.3)
// ---------------------------------------------------------------------------

/**
 * A record of "we tried this peer's hypothesis, and the local
 * 5-step gate said yes/no." Append-only, separate from the
 * main `Scoreboard` so a federated pull can't pollute the
 * local cycle counter.
 *
 * **Why a separate file?** the main scoreboard is the local
 * cycle log. Federated evaluations are a different concern —
 * they record "peer X's hypothesis Y, evaluated locally, the
 * local gate said Z". Mixing them would make the local cycle
 * counter meaningless.
 *
 * **What `localEntry` references:** the LOCAL `ScoreboardEntry`
 * that the federated evaluation produced. The link is
 * `(localEntry.version, peerId, sourceEntry.version)` — three
 * fields, all unique together. v0 doesn't enforce uniqueness;
 * the operator inspects the file to deduplicate.
 */
export const FederatedAdoptionRecordSchema = z.object({
  /** The peer that proposed the candidate. */
  peerId: z.string().min(1),
  /** The peer's scoreboard entry (the source of the candidate). */
  sourceEntry: z.object({
    version: z.number().int().positive(),
    hypothesis: z.string().min(1),
    rulesetHash: z.string().min(1),
    passRateAfter: z.number().min(0).max(1),
    ownerSignature: z.string().min(1),
  }),
  /** The local scoreboard entry produced by the evaluation.
   *  Absent when the local cycle errored before producing one. */
  localEntry: z.object({
    version: z.number().int().positive(),
    passRateBefore: z.number().min(0).max(1),
    passRateAfter: z.number().min(0).max(1),
  }).optional(),
  /** Whether the local gate kept the candidate. */
  kept: z.boolean(),
  /** ISO 8601 timestamp. */
  adoptedAt: z.string().datetime(),
  /**
   * Optional reason (for rejected cases). e.g.
   * "local-pass-rate-did-not-improve" or "local-cycle-error: ..."
   */
  reason: z.string().optional(),
});
export type FederatedAdoptionRecord = z.infer<typeof FederatedAdoptionRecordSchema>;

export const FederatedAdoptionsSchema = z.array(FederatedAdoptionRecordSchema);
export type FederatedAdoptions = z.infer<typeof FederatedAdoptionsSchema>;

// ---------------------------------------------------------------------------
// VerifierRuleset — a versioned list of rules
// ---------------------------------------------------------------------------

/**
 * A versioned set of verifier rules. The `hash` is computed
 * deterministically from the rules' names and short summaries;
 * the full rule bodies live in code (TypeScript) and are not
 * serialized.
 *
 * **Why not serialize the rule bodies?** The rules are
 * deterministic TypeScript functions. Re-loading them from disk
 * is brittle (the file would have to re-execute the same code).
 * The scoreboard only needs to know "did the ruleset change?",
 * not the bodies themselves.
 */
export interface VerifierRuleset {
  /** SHA-256 hash of the rules (names + summaries + order). */
  hash: string;
  /** The rules in order. */
  rules: ReadonlyArray<VerifierRule>;
}

// ---------------------------------------------------------------------------
// Benchmark — the frozen test set
// ---------------------------------------------------------------------------

/**
 * A benchmark task's worker result, as data.
 *
 * **Why this exists.** The first benchmark could only feed four canned
 * shapes (`stubKind`), which cannot express the cases that actually
 * separate one ruleset from another: a partial keyword overlap, a
 * tool call with no prose, a *blocked* write (`isError: true`) versus a
 * write that bypassed the sandbox (`isError: false`). A task that cannot
 * state its input cannot carry a label the loop can learn from.
 *
 * The boilerplate fields (`stopReason`, `iterations`, `toolCalls`,
 * `messages`, `sandboxPolicy`, `metrics`) have defaults so a YAML task
 * can state just the part that matters — usually `content`, and
 * optionally `messages` / `metrics.costUsd`.
 *
 * **Not a security boundary:** a fixture is authored data, not a live
 * worker. It is validated so a typo fails at load time instead of
 * producing a silently-different result.
 */
/**
 * A JSON-shaped payload for the opaque `args` / tool-result `content`
 * fields.
 *
 * **Why not `z.unknown()`:** zod treats an `unknown` key as optional, so
 * the parsed type has `args?: unknown`, which is not assignable to the
 * harness's `ContentBlock` (`args: unknown`) under
 * `exactOptionalPropertyTypes`. Spelling out the JSON value types keeps
 * the key required and the value assignable.
 */
const BenchmarkJsonValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.unknown()),
]);

export const BenchmarkContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    mimeType: z.string(),
    data: z.string(),
  }),
  z.object({
    type: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    args: BenchmarkJsonValueSchema,
  }),
  z.object({
    type: z.literal("tool_result"),
    toolCallId: z.string(),
    content: BenchmarkJsonValueSchema,
    isError: z.boolean(),
  }),
]);

export const BenchmarkMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.array(BenchmarkContentBlockSchema),
});

export const BenchmarkSandboxPolicySchema = z.object({
  mode: PermissionModeSchema,
  approval: AskForApprovalSchema,
  backend: SandboxBackendSchema,
  writableRoots: z.array(z.string()),
  networkAccess: z.boolean(),
  slashTmpWritable: z.boolean(),
});

export const BenchmarkAgentResultSchema = z.object({
  content: z.array(BenchmarkContentBlockSchema),
  stopReason: z
    .enum([
      "end_turn",
      "tool_use",
      "max_tokens",
      "stop_sequence",
      "max_iterations",
      "aborted",
    ])
    .default("end_turn"),
  iterations: z.number().int().nonnegative().default(1),
  toolCalls: z.number().int().nonnegative().default(0),
  messages: z.array(BenchmarkMessageSchema).default([]),
  sandboxPolicy: BenchmarkSandboxPolicySchema.default({
    mode: "workspace-write",
    approval: "on-request",
    backend: "linux-landlock",
    writableRoots: ["/tmp"],
    networkAccess: false,
    slashTmpWritable: true,
  }),
  metrics: z
    .object({
      inputTokens: z.number().nonnegative().default(0),
      outputTokens: z.number().nonnegative().default(0),
      costUsd: z.number().nonnegative().default(0),
    })
    .default({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
});

/**
 * One task in the frozen benchmark. The benchmark is the
 * evaluation set the self-evolution protocol runs against;
 * it must be FROZEN (no edits during a cycle) so the pass
 * rate is comparable across cycles.
 */
export const BenchmarkTaskSchema = z.object({
  /** Stable task id. */
  id: z.string().min(1),
  /** The user objective (what the worker was asked to do). */
  objective: z.string().min(1),
  /**
   * Optional gold output. When present, the benchmark compares the
   * worker's text against it (whitespace-normalized, case-preserved)
   * as a **fixed term** of the criterion — never as a selectable rule,
   * so the optimiser cannot deselect the thing that measures it. See
   * `DefaultBenchmarkRunner`.
   */
  goldOutput: z.string().optional(),
  /**
   * The verdict the verifier ought to return for this result. The task
   * passes iff `combined.kind === expectedVerdict` (and, when
   * `goldOutput` is present, the output also matches gold).
   *
   * **Every task in the v1 benchmark sets this.** It is optional in the
   * schema only so pre-existing fixtures still load; a missing value is
   * treated as `"pass"` (see the runner), which is easy to do by
   * accident, so `test/benchmark-discrimination.test.ts` rejects a
   * canonical task that omits it.
   *
   * **Why an enum, not a `z.literal` union?** The discriminated
   * union's `kind` field doesn't have a `shape` (zod limitation).
   * The enum is the canonical list of `Verdict.kind` values.
   */
  expectedVerdict: z.enum(["pass", "partial", "fail", "disputed"]).optional(),
  /**
   * Pre-built `AgentResult` to feed the verifier, for cases the four
   * canned shapes cannot express (partial overlap, a blocked versus a
   * bypassed write, exact cost boundaries). **Takes precedence over
   * `stubKind`** when both are present.
   */
  agentResult: BenchmarkAgentResultSchema.optional(),
  /**
   * A canned result shape. Use `agentResult` when a task needs precise
   * control; this is shorthand for the common clean/unclean cases.
   */
  stubKind: z.enum(["empty", "ok", "off-topic", "forbidden-path"]).default("ok"),
});
export type BenchmarkTask = z.infer<typeof BenchmarkTaskSchema>;

export const BenchmarkSchema = z.object({
  /** Benchmark name. */
  name: z.string().min(1),
  /** The frozen test set, in order. */
  tasks: z.array(BenchmarkTaskSchema).min(1),
});
export type Benchmark = z.infer<typeof BenchmarkSchema>;

// ---------------------------------------------------------------------------
// BenchmarkResult — the cycle's score
// ---------------------------------------------------------------------------

/**
 * What the benchmark runner returns.
 *
 * A task **passes** iff the combined verdict's `kind` equals the task's
 * `expectedVerdict` (or is `pass` when none is declared) **and** — when
 * the task declares `goldOutput` — the worker's text matches gold.
 * `passRate` is the fraction of tasks that pass; `meanScore` is the mean
 * of `verdict.score` over `pass` verdicts (0 when none).
 *
 * **Why both?** `passRate` is what we optimize on (the cycle
 * keeps the change iff `after.passRate > before.passRate`).
 * `meanScore` is for human inspection — a 100% pass rate with
 * a 0.5 mean is suspicious.
 */
export interface BenchmarkResult {
  passRate: number;
  meanScore: number;
  nRuns: number;
  /** Per-task pass/fail, for diagnostics. */
  tasks: ReadonlyArray<{
    id: string;
    pass: boolean;
    /** Present only when the task declared a `goldOutput`. */
    gold?: "match" | "mismatch";
  }>;
}
