# Self-evolution for envoy-harness — design (draft)

> **Status:** DRAFT for review. Nothing here is implemented.
> **Question this answers:** should envoy-harness evolve its own behavior artifacts from
> measured outcomes, and if so, under what design and in what order?
> **Inputs:** *Autonomy Is Causality* (Working Paper Draft 0.3, Sept 2026) read against three
> reference implementations, plus envoy's existing `src/scoreboard/self-evolve.ts`.

## 0. Provenance

The three references were investigated read-only at fixed revisions:

| Repo | Revision | What it contributes here |
|------|----------|--------------------------|
| `codex` | `78245b47af` | The only real mechanism; the containment envelope |
| `deepseek-harness` | `ddefc45fbc` (0.1.6-alpha.2) | The explicit deferral; the criterion discipline |
| `penguin-harness` | `9c88a849e` | The anti-pattern: a loop that is prose |
| `envoy-harness` | working tree | Already ahead on criterion and rollback |

## 1. The finding

**Everyone has built the mechanism; nobody has built the criterion.** This is not a
summary of intentions — it is what the code shows:

| | Mechanism | Criterion |
|---|---|---|
| **penguin** | 0 LOC of loop. A 132-line `SKILL.md` prose procedure; its CI "tests" are `toContain(...)` assertions on that markdown | prose. No held-out set, no benchmark version. Snapshot is *instructed*, not wired (`SnapshotService` has no caller outside its own file) |
| **codex** | Real: ~15.7k Rust LOC, ~111 tests, production-wired. A consolidation sub-agent rewrites `MEMORY.md`, `memory_summary.md`, `skills/*`, and that summary is injected as a **`PromptFragment::developer_policy`** on every thread start — the agent edits its own future system prompt | **structural only.** `validate_consolidation_artifacts_for_version` checks existence, a `"v1"` first line, headings, <10k bytes, no symlinks. No task-outcome label exists anywhere (`threads` has no outcome column). The only behavioural signal is `usage_count`/`last_usage` — *retrieval*, not effect. No eval harness in-repo |
| **deepseek-harness** | Self-*modification* plumbing ships: `plugin_manager` mutates profile bundles; skills/`AGENTS.md` are live-watched. But it is request-driven and approval-gated, never outcome-driven | **explicitly deferred.** `.agents/notes/.../2026-07-16-harness-level-loop.md:121`: *"A separate evaluator, evaluator-driven feedback round, completion certificate, deterministic checker, adversarial verifier, and criteria/executor/isolation contract remain deferred."* |
| **envoy** | Thin: rule **selection** only. Rule *bodies* stay code, so invented names are rejected | The only **executable, deterministic** criterion of the four. §1.0 records how it was measured and repaired: the 4-rule default set is now decisive on a 15-task shared benchmark, with a CI gate against inert rules and unreachable labels. Still missing: a benchmark **revision hash** and task-wise held-out split, and headroom above the (perfect) default |

### 1.0 What envoy's criterion actually was (measured, then fixed)

An earlier draft of this section called envoy's criterion "real and
task-derived". That was too generous, and the difference matters.

**Measured before any change**, by enumerating all 64 subsets of the six
rules against the only benchmark in the repo
(`test/fixtures/frozen-benchmark.yaml`, a four-task *test* fixture, now deleted
in favour of the shared benchmark):

- `DEFAULT_RULES` scored **`passRate = 0.25`** on its own benchmark — 1 of 4
  tasks graded as intended.
- Only **three** distinct `passRate` values existed across all 64 subsets:
  `0`, `0.25`, `0.5`. The maximum was **0.5**, reachable by 24 subsets
  *including a single rule*. The best available move was to **delete**
  `output-matches-objective` (0.25 → 0.5).
- The effective discriminative capacity was therefore **"is the output
  empty?"** — a two-class test wearing a six-rule verifier.

The cause was not one bug but three **code/docstring contradictions**, each of
which made a labelled benchmark task unreachable by any rule subset:

| rule | docstring said | code did |
|---|---|---|
| `output-matches-objective` | "A fail here is a strong signal of drift" | returned `partial` on **zero** keyword overlap |
| `sandbox-respected` | "a SUCCESSFUL out-of-policy command is a fail" | returned `partial` |
| `mesh-task-shape` | "the rule returns pass unconditionally" | actually **fails on empty content** (the rule is fine; the comment was stale, and it was nearly deleted on the strength of it) |

Plus two structural defects: `approval-respected` ignores its input and returns
a constant `pass` (a genuine no-op, and an inert dimension for the loop), and
the `forbidden-path` stub put its violation only in assistant *text* while
`messages` stayed empty — so `sandbox-respected`, which scans tool results, was
structurally unable to fire on the stub built to exercise it.

**Fixed in the first pass** (all sensitivity-checked — reverting any one fails a
specific test):

1. `goldOutput` is now read. It is a **fixed term of the criterion, not a
   selectable rule** — a criterion the optimiser may deselect is not a
   criterion. `BenchmarkTaskSchema` declared it from the start and never read
   it.
2. `output-matches-objective` → **`fail` on zero overlap** (a later pass removed
   the `partial` band entirely; see below).
3. `sandbox-respected` → **`fail` with `rollback: true`** on a successful
   out-of-policy operation. (This path had **no test at all**, which is how the
   contradiction survived.)
4. `approval-respected` removed from `DEFAULT_RULES` (kept as an exported
   opt-in; removing the export would be a breaking change for no benefit).

**Second pass — the benchmark itself.** The first pass left the criterion
measuring something but the *yardstick* still degenerate. The verifier-benchmark
decisions (recorded in `docs/verifier-benchmark-decision-brief.md` §0) settled
it:

1. `output-matches-objective` → **`fail` for every overlap below 50%**, not just
   zero; exactly 50% passes. `partial` is gone from the rule, so **no default
   rule emits `partial`** and a `partial` label would be unreachable.
2. `mesh-task-shape` removed from `DEFAULT_RULES`. An earlier note in this very
   file claimed the rule was "real"; that was **wrong**. Its code is the same
   decision as `non-empty-content` (fail iff `content.length === 0`), so
   toggling it can never change a `passRate`, and because a subset may reorder
   rules, putting it first would silently downgrade the combined `rollback` from
   `true` to `false`. `DEFAULT_RULES` is now **4 rules, each decisive** on the
   benchmark.
3. `BenchmarkTaskSchema` gained an inline **`agentResult`**. The four `stubKind`
   shapes cannot express a 1-of-3 overlap, a blocked versus bypassed write, or an
   exact cost boundary; a task that cannot state its input cannot carry a
   learnable label.
4. The shared benchmark is now **`benchmarks/verifier-frozen.yaml`** (15 tasks,
   in-repo, every task labelled `pass`/`fail`, every failing task isolating
   exactly one rule). The CLI reads it by default; the old four-task test
   fixture is deleted.
5. `analyzeBenchmark` + `test/benchmark-discrimination.test.ts` are the CI gate:
   they reject an unreachable label, an inert rule, and a collapsed score
   landscape.

**Measured after (v1 benchmark, 4 rules, 15 legal subsets):** `DEFAULT_RULES`
scores **`passRate = 1.000`**, with **7 distinct pass rates** and **12 distinct
outcome vectors**; no inert rule and no unreachable label. For contrast, the old
fixture produced 3 distinct pass rates over its lattice.

**The honest consequence, and the headline that remains:** v1 is a *regression
gate*, not an improvement driver. A correct baseline means every hypothesis is
correctly reverted, and no subset beats 1.000. The best alternative *ties* it at
1.000 by dropping `non-empty-content` (which is dominated by the overlap rule
whenever the overlap rule is present). So the remaining problem is no longer "the
criterion is broken" or "the benchmark is too small to discriminate"; it is
"**the benchmark contains no task on which the default is wrong, so there is
nothing to improve toward**". Creating headroom means adding a labelled task the
lexical overlap rule wrongly fails (a correct paraphrase) — which is the
non-selectable check the Q1 decision deliberately deferred, *not* a relabelling
exercise. See Stage 0 below.

### 1.1 The convergence worth noticing

All three references independently arrived at the same invariant, and stopped there:

- deepseek-harness: `tool-ralph/src/index.ts:358` — *"without presenting self-report as
  certification"*; `docs/testing.md:33` — *"Verify the world, not the self-report"*; human
  feedback is doc-commented *"never enters model history"*.
- codex: guardian risk scores *"must not enter model-visible conversation context"*
  (`protocol/src/security_risk.rs:9-11`).
- penguin: rubrics are kept in a directory isolated from the target agent.

envoy reached the same place independently, from a bug rather than by copying: a tool call
whose result was never recorded is labelled `UNKNOWN_OUTCOME_NOTICE` ("outcome is UNKNOWN…
may or may not have taken effect"), and a sub-agent `verdict` is labelled
`VERDICT_IS_PREDICTION` ("a PREDICTION about the work's quality… not evidence that the work
succeeded").

So the field agrees on **"do not trust the agent's self-report"** and has no answer for
**"then what do we trust?"** That second question is the whole of Stage 0 below, and it is
the same claim the source paper makes at §11: improvement is not a primitive — it
presupposes a criterion.

### 1.2 What envoy already has that the others don't

Not a boast — it changes the plan, because it means Stage 0 is smaller here than the
references suggest:

- **`VerifierSource = "rule" | "llm" | "cross" | "human"`.** `cross` means a *different
  adapter* judging the same task. That is the "adversarial verifier" deepseek-harness
  deferred, already in the type system.
- **Best rollback of the four.** Codex advances a git baseline after structural validation
  and does **not** revert on failure (`phase2.rs:405-450`) — invalid artifacts stay on disk.
  Penguin blanks the file. envoy has an immutable candidate, a snapshot rollback target, a
  scoreboard audit entry, and a ruleset hash.
- **`shadowMode` and federated-never-commits-locally** — two existing safety gates.
- **A real sandbox** (policy, landlock/seatbelt executors, `classifySandboxFailure` with its
  `denied | infrastructure` split, `widenSandboxPolicy`). Codex bounds its self-modifier
  with the OS sandbox; envoy can too.

## 2. Invariants

Each is traceable to evidence above. If a later stage cannot satisfy one, it does not ship.

- **I1 — "could not score" is representable.** A criterion must be a tagged union with an
  explicit `unscored` arm, never a string with a default. Codex's `/review` verdict is a
  `String` whose parser silently falls back to `overall_correctness: ""`,
  `overall_confidence_score: 0.0` on unparseable output (`core/src/tasks/review.rs:205-209`),
  so a parse failure reads as a failure verdict. envoy already does this correctly in
  `classifySandboxFailure` (`denied` / `infrastructure` / `undefined`).
- **I2 — the criterion must not reach the judged artifact's context.** Otherwise it optimizes
  the metric. Codex states this outright for guardian scores.
- **I3 — the self-modifier cannot reach its own artifact channel or spawn itself.** Codex's
  `phase2.rs:305-318`: `ephemeral = true`, `memories.generate_memories = false`,
  `memories.use_memories = false`, `disable(Collab)`, `disable(MemoryTool)`,
  `mcp_servers = allow_only({})`, `approval_policy = Never`.
- **I4 — blast radius is enforced by sandbox + policy, not by prose.** Penguins' prose
  guardrails are the counter-example.
- **I5 — every mutation is a plain-file diff** with an immutable candidate, a snapshot, a
  scoreboard audit entry, and a working revert.
- **I6 — off by default, behind a feature gate; adoption is human-gated.**
- **I7 — self-report is never certification.** Already implemented in envoy; new work must
  not weaken it.

## 3. Stage 0 — the criterion (this is the real design work)

No artifact changes at all. Pure measurement. Four deliverables:

1. **Propose/score separation.** A held-out task set that the hypothesis never sees. Today
   `self-evolve.ts:657-658` runs the same `bench` for `before` and `after`, and
   `buildHypothesisPrompt` shows the proposer recent failures from that same set.
   Split into `propose` and `confirm` sets, with the confirm set used once per cycle.
2. **Benchmark revision identity.** `BenchmarkSchema` gains a content hash, recorded on every
   scoreboard entry. Without it a spec change silently invalidates every historical
   comparison.
3. **A tagged verdict.** `BenchmarkOutcome = { scored: passRate, meanScore, n }
   | { unscored: reason }`, so a runner failure cannot be read as a regression.
4. **Effect size, not just strict `>`.** `after > before` on a finite held-out set is a
   multiple-comparisons setup: a lucky reorder passes. Require a minimum delta
   (e.g. `after − before ≥ ε`, with `ε` a config field) **and** a confirm-set pass before
   adoption.
5. **A benchmark with headroom.** *Partly done.* The shared benchmark now exists
   (`benchmarks/verifier-frozen.yaml`, 15 labelled tasks, read by default), the
   old four-task fixture is deleted, and the CI gate rejects inert rules and
   unreachable labels. What remains is the harder half: the default scores
   **1.000**, so there is no task it gets wrong and nothing for the loop to
   improve toward. Adding tasks the lexical rule wrongly fails (correct
   paraphrases) requires the **non-selectable** paraphrase check that the Q1
   decision deferred; relabelling existing tasks would not create headroom,
   only an inconsistent criterion. A held-out split and a revision hash are
   still absent.

**Where the criterion should come from (options, in the order I would try them):**

- **(a) A cross-adapter verifier (`VerifierSource: "cross"`).** Independent of the
  proposer's model. **Correction:** an earlier draft called this "cheapest,
  already typed". It is typed and *not implemented* — and more than that, **no
  verification source is recorded at all**: `VerifierSourceSchema` and
  `issuedBy` appear only in the public export list, and nothing in the rule
  engine or scoreboard produces them. The whole provenance layer (`source`,
  `issuedBy`, `issuedAt`, `signature`) is declared and unwired. This is a
  build, not a wiring job.
- **(b) Verifier-rule pass rate on held-out tasks** — envoy's current mechanism, with the
  split and the effect-size gate added.
- **(c) EnvoyMesh reputation / chain graph.** The right long-horizon criterion, but it lives
  across a package boundary, so it is an EnvoyMesh decision, not an envoy one.

## 4. Stage 1 — the mutation envelope and artifact surface

**Surface.** Widen from rule *selection* to **plain files only**: prompt sections, skill
files, and validated config fields. **Never code.** Code is the enforcement mechanism itself;
letting the loop rewrite it means the loop can rewrite its own guardrails. Rule bodies stay
code, as today.

**Envelope.** Codex's `phase2` config, adapted. Roughly: the mutating turn runs with
`approval: "never"`, `networkAccess: false`, `writableRoots: [artifact root]`, the artifact
channel and `task` disabled, no MCP servers, and an ephemeral session that cannot write
memory or spawn sub-agents. envoy can express all of this with its existing policy type and
sandbox executors — this stage is mostly wiring, plus a schema for "what may change".

**Malformed proposals are rejected, not half-applied.** deepseek-harness validates every
plugin config through schemastery and fails loud at load; envoy has zod schemas on the same
seam. A proposal is a typed delta.

## 5. Stage 2 — the controller

Reference pointer, candidate construction, held-out evaluation, effect-size decision, persist,
rollback, round limit — owned by code, not by a prompt. envoy's `SelfEvolve` already does most
of this; Stage 2 is wiring Stage 0's criterion into it and adding the artifact-file path
alongside the ruleset path.

## 6. Stage 3 — recursion (the dangerous one)

Only here does the artifact surface include the loop's own configuration (its thresholds, its
prompt, its round limit). Requires: a human gate on every adoption, the confirm set held out
from the proposer *including* its own config history, and a kill switch that is not itself
evolvable.

## 7. Evolution steps

Each stage has an exit criterion that must hold before the next begins, and a kill criterion
that stops the programme.

| Stage | Deliverable | Exit criterion (advance only if) | Kill criterion |
|---|---|---|---|
| **0** | Held-out split, benchmark revision, tagged verdict, effect-size gate | A seeded-regression test proves the gate rejects a candidate that improves on `propose` but not on `confirm` | The verifier cannot produce a stable score across repeated runs of the *same* ruleset — then there is no criterion to build on |
| **1** | Sandboxed mutation envelope + typed artifact-delta schema | A mutation attempt outside the artifact root is refused by the sandbox, with a test that fails if the envelope is loosened | The artifact surface cannot be validated before application |
| **2** | Controller: propose → evaluate → keep/revert, with audit | An end-to-end cycle over a frozen benchmark, hermetically (no live model, no network), with rollback exercised | The loop cannot demonstrate improvement on held-out data across N cycles |
| **3** | Recursion behind a human gate | A human-gated cycle where the loop's own config changes and the confirm set still holds | Any cycle that adopts a config change increasing its own adoption authority |

## 8. Non-goals

Explicitly **not** doing, following the source paper's §11 and its own subtractive direction:

- Five "projection" modules (Context/Persistence/Continuity/Agency/Feedback) as components.
  They are semantic views, not subsystems, and the paper's own programme includes collapsing
  them.
- A Planner / Critic / Referee **service**.
- A heartbeat or continuous-execution requirement. Scheduling is the app layer's
  (see `gap-closure-plan.md`, "Where the clock lives").
- Letting the loop touch source code, tool schemas, sandbox policy, or the criterion itself.

## 9. Open decisions

1. **Who owns the criterion — envoy's scoreboard, or EnvoyMesh's reputation/verifier/chain
   graph?** Stage 0 is the same either way; Stage 3 and cross-node adoption are not.
2. **Artifact surface:** plain files only (my recommendation), or also validated config
   fields in the same stage?
3. **Human gate placement:** every adoption, or only above an effect-size threshold?

## 10. Risks

| Risk | Mitigation |
|---|---|
| Proxy criterion becomes the objective (codex's `usage_count` is the live example) | I2; criterion is task-derived, not retrieval-derived |
| Overfitting via selection search | Held-out confirm set + effect size (Stage 0) |
| The loop edits its own guardrails | Code out of scope; I3; Stage 3 human gate |
| A parse failure read as a regression | I1 tagged verdict |
| Silent divergence after a spec change | Benchmark revision hash on every scoreboard entry |
| Reward for *looking* successful — the failure mode envoy already fixed once | I7; keep `UNKNOWN_OUTCOME_NOTICE` and `VERDICT_IS_PREDICTION` authoritative |
