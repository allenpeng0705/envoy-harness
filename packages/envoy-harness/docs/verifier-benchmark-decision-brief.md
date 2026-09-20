# Verifier-benchmark decision brief

> **Status:** DECIDED. The seven calls below are settled and implemented; the original
> questions are kept for the rationale.
> **Settled already:** the criterion grades the **verifier's judgements** ("given this result,
> is the verdict right?"), not the agent's work. Deterministic, no model in the loop. Do not
> re-decide this.

## 0. Decisions (the scannable board)

| # | Question | Decision | Kind | Confidence | Agrees with provisional? |
|---|---|---|---|---|---|
| Q1 | Low overlap (1 of 3 terms) | **`fail`** | domain | high | yes |
| Q2 | Final result with no prose (tool call only) | **`fail`** — keep the existing label | domain | high | yes |
| Q3 | `EACCES` with `isError: true` (blocked) | **`pass`** | domain | medium | yes — the call a domain owner is most likely to overturn |
| Q4 | When to return `disputed` | **Keep only the empty-verdict-list trigger.** Do not invent a second | technical | high | **no** — the provisional "two rules disagree" trigger would contradict the combiner |
| Q5 | Inputs | **Synthetic first**, recorded later | process | high | yes |
| Q6 | Scope | **~15 tasks first, plus the discrimination check in CI now** | process | high | yes on the size; the check is not postponed |
| Q7 | Location | **One shared benchmark, in-repo** | process | high | yes |

**Settle these before authoring tasks** (all applied):

1. Change the overlap rule first — Q1's `fail` is unreachable until `ratio < 0.5` returns `fail`.
2. Let a task carry an **inline `AgentResult`**. The four `stubKind` values cannot express a
   1-of-3 overlap or a blocked write.
3. **No `partial` or `disputed` labels in v1.** After Q1, no default rule emits either.
4. **Every task sets `expectedVerdict`.** If it is omitted the runner scores the task as
   "combined kind must be pass", which is easy to do by accident.
5. Compute keywords with `extractKeywords` (length ≥ 4, stop list, substring `includes`) —
   never assign overlap by eye.
6. Fix the Q3 fixture shape: a blocked call **plus a real answer** is `pass`; a blocked call
   with no prose is Q2's `fail`, not the sandbox rule's.
7. Pin the edges the code already uses: `cost > budget` fails, `cost === budget` passes;
   `ratio === 0.5` passes and only `ratio < 0.5` fails; zero cost always passes.

**What the settlements produced in code**

- `src/verifier/rules/index.ts` — overlap rule returns `fail` below 50%; `mesh-task-shape` was
  removed from `DEFAULT_RULES` (it made the same decision as `non-empty-content`, so toggling it
  could never change a score, and reordering it could weaken `rollback`). `DEFAULT_RULES` is now
  4 rules, each decisive on the benchmark.
- `src/scoreboard/types.ts` — `BenchmarkAgentResultSchema` and the inline `agentResult` field.
- `benchmarks/verifier-frozen.yaml` — the shared v1 benchmark, 15 tasks, every one labelled and
  every failing task isolating exactly one rule.
- `src/scoreboard/discrimination.ts` — measures unreachable labels, unrefutable tasks and inert
  rules; `test/benchmark-discrimination.test.ts` is the CI gate over it.


## 1. What the system is

**envoy-harness** is a TypeScript agent harness (library + CLI). It runs LLM coding sessions and
can delegate sub-tasks to sub-agents, either locally or across a peer-to-peer mesh.

**The verifier.** When a worker (a sub-agent or a peer) produces a result, the verifier judges
whether that result actually answers the objective. It runs a set of small, deterministic
**rules** over the worker's `AgentResult` — its content blocks, its tool-result messages, its
sandbox policy, and its metrics such as cost — and combines their verdicts into **one** of four
outcomes:

| outcome | documented meaning |
|---|---|
| `pass` | acceptable |
| `partial` | "acceptable for some blocks; the rest are unusable" |
| `fail` | unacceptable |
| `disputed` | uncertain; escalate to a human |

**The current default rules** (all deterministic; no model is called):

1. the output is non-empty;
2. the output shares **≥ 50%** of the objective's key terms (words ≥ 4 characters) — below
   that is `fail`, not `partial`;
3. no tool result shows a *successful* operation that reported a permission error — i.e. an
   out-of-policy write that nonetheless succeeded;
4. the cost is within a per-objective budget.

(`mesh-task-shape` was removed from the default set: it made the same decision as rule 1, so
toggling it could never change a score. `approval-respected` was removed for the same reason —
it is a constant `pass`.)

**How verdicts combine:** if any rule returns `fail`, the result is `fail`. Otherwise, if all
rules pass, `pass`. Otherwise `partial` (with the reason string `"verifier disagreement"`). If
**no** rule produces a verdict at all, `disputed`.

## 2. Why a benchmark of judgements is needed

A self-evolution loop may propose a change to **which rules are used** — it may subset or
reorder the existing rules, but rule *bodies* are code and cannot be invented or edited by the
loop. Each proposal is scored against a frozen **benchmark** and kept only if the score strictly
improves.

**A benchmark task is:** an objective + one specific worker result + **the verdict the verifier
ought to return**. The score is the fraction of tasks where the verifier's combined verdict
equals the label.

Today the benchmark is `benchmarks/verifier-frozen.yaml`: **15 tasks**, every one labelled
`pass` or `fail`, every failing task isolating exactly one rule. Before it, a 4-task fixture
scored 25% against the default rules and could not distinguish rulesets at all.

**Constraints any answer must respect:**

- the criterion must be **deterministic and hermetic** — no live model, no network — so that CI
  and the loop are reproducible;
- the labels are a **fixed part of the criterion**: the loop must not be able to edit them or
  deselect the thing that measures it;
- the labels must **never be visible to the proposing model** (contamination);
- envoy must stay **self-contained**; the criterion may not depend on the mesh.

## 3. The four open questions

Current behaviour below is **verified by running the rules**, not inferred.

### Q1 — Low overlap: `partial` or `fail`?

**Current (after Q1):** an output matching **1 of 3** objective key terms yields `fail`;
matching **2 of 3** yields `pass`. The rule returns `fail` for every ratio below 50% and never
returns `partial`, so no default rule produces `partial` at all.

**Why it's ambiguous.** Keyword overlap is a crude lexical proxy: a correct answer may use
different vocabulary. But sharing only a third of the objective's terms may equally mean the job
was not done.

**An extra wrinkle worth weighing.** The documented meaning of `partial` is *"acceptable for some
blocks; the rest unusable"* — a notion about **multi-block content**. Here `partial` is instead
being used for *"the rules disagree"* or *"the answer is vaguely on topic"*. Two different ideas
are collapsed into one value.

- *For `partial`:* do not fail an answer on a crude lexical signal; route it to a stronger check
  or a human.
- *For `fail`:* 1-in-3 overlap usually means the task was not addressed; `partial` risks accepting
  a wrong answer.

**Provisional recommendation: `fail`** — because `partial`'s documented meaning (some blocks
usable) is not established by low lexical overlap, and the reason string a human sees
("verifier disagreement") is misleading for a genuinely off-topic answer.

### Q2 — A final result with no prose (only a tool call): pass or fail?

**Current: `fail`** (reason `"empty output"`). *(An earlier internal note of ours wrongly recorded
this as `pass`; the probe corrected it.)*

**Why it's ambiguous.** The worker may have done the work through tools; the objective might be
satisfied even though the final message carries no prose. But the requester received no answer.

- *For `fail`:* a result with no prose is not an answer; the requester cannot act on it.
- *For `pass`/`partial`:* tool results are evidence the work happened, and failing it punishes a
  legitimate "did it, nothing to add" outcome.
- *Complication to resolve either way:* mid-loop assistant turns are tool-call-only **by design**.
  If the verifier cannot distinguish a final result from an intermediate turn, this rule may
  misfire.

**Provisional recommendation: keep `fail`**, contingent on the verifier being able to tell a
final result from an intermediate turn.

### Q3 — The sandbox blocked the operation (`EACCES` with `isError: true`): pass or fail?

**Current: `pass`.** *(For contrast: `EACCES` with `isError: false` — a successful out-of-policy
operation — is `fail`.)*

**Why it's ambiguous.** The agent failed to do the thing. But the policy worked exactly as
intended, and the model sees the tool error and can adapt on its next turn.

- *For `pass`:* the verifier judges whether the **output** is acceptable, not whether every
  attempted operation succeeded; a blocked operation is expected behaviour, and the harness
  already surfaces it to the model.
- *For `fail`/`partial`:* the objective ("write a file") was not achieved, so from the
  requester's perspective this is not a success; passing it could let a blocked workflow be
  recorded as complete.

**Provisional recommendation: `pass`** — the sandbox is a safety mechanism whose interventions are
expected. This is the question where a domain owner is most likely to disagree.

### Q4 — When should the verifier return `disputed` (escalate to a human)?

**Current: effectively never.** `disputed` is reachable only when **no** rule produces a verdict —
an empty rule set, or every rule abstaining. With the default rules it is unreachable: a clean
result yields five `pass` verdicts. So one of four enum values is dead.

**Candidate triggers.** Rules conflict in a way neither can adjudicate; the objective shares no
terms with the output yet the output is confidently on-topic in another vocabulary; cost or risk
sits exactly on a threshold; a task marked human-only by the benchmark itself.

**Provisional recommendation:** give it **one real trigger** — *two or more rules disagree in a
way that severity cannot resolve* (a pass and a fail coexist, or a partial and a fail coexist in
different blocks) — and leave it otherwise unreachable. Removing the value entirely is also
defensible if we want the smallest possible vocabulary.

## 4. The three process questions

### Q5 — Inputs: synthetic shapes now, or recorded results first?

- *Synthetic (current):* cheap, fully controlled, and can express boundary cases a real run rarely
  produces (e.g. "overlaps by exactly one third"). Unrealistic.
- *Recorded real results:* realistic. Requires a recording and normalization pipeline — volatile
  values such as absolute paths, ids and timings must become stable tokens — and boundary cases
  still have to be hand-authored regardless.

**Provisional recommendation: staged** — synthetic now, recorded later. Boundary cases will always
be authored by hand; recorded cases add realism.

### Q6 — Scope: ~15 tasks first, or the full thing at once?

- *Minimal first:* ~15 labelled tasks — enough to validate the approach and the labels.
- *Full immediately:* ~30–60 tasks, a held-out propose/confirm split, a revision hash, and a CI
  check that the task set can actually discriminate between rule subsets.

**Provisional recommendation: ~15 first.** The labels are the uncertain part; validating them
cheaply beats authoring 60 and discovering the metric is wrong.

**The specific failure being guarded against:** with the previous 4-task set, **16 of 32**
possible rule subsets scored *identically*, so the benchmark could not distinguish rulesets at
all. The check now runs in CI (`test/benchmark-discrimination.test.ts`): it fails if any default
rule is inert, if any label is unreachable by every subset, or if the pass rates collapse.

**Measured on the v1 benchmark (4 rules, 15 tasks, 15 legal subsets):** 7 distinct pass rates and
12 distinct outcome vectors; no inert rule; no unreachable label. The default ruleset scores
**1.000** and no other subset beats it (the best alternative ties it at 1.000 by dropping
`non-empty-content`, which is dominated by the overlap rule whenever the overlap rule is
present). So on v1 the loop can only *revert*: the benchmark is a regression guardrail, not a
source of improvements. Headroom would require a labelled task on which the default is *wrong* —
e.g. a correct paraphrase the lexical rule rejects — which is exactly the check deferred in Q1.
Do not manufacture such a task by relabelling; add the non-selectable check first.

### Q7 — Location: one shared benchmark in-repo, or a per-deployment set?

- *Shared, in-repo:* scores are comparable across deployments — a prerequisite for the federated
  feature in which one node adopts rule candidates validated by another. Also keeps the labels
  reviewable in one place.
- *Per-deployment:* each operator grades against their own standards, but cross-node score
  comparison becomes meaningless.

**Provisional recommendation: shared, in-repo.** If federation is to mean anything, the yardstick
must be the same.

## 5. What to return

For each of **Q1–Q7**: your decision, a one-paragraph justification, and a confidence level.

- Mark which you consider **genuine domain-judgement calls** rather than technical ones.
- Where you disagree with a provisional recommendation, say so explicitly and give your reason.
- Finally, list any decision you believe we have **missed** that must be settled before this
  benchmark is built.
