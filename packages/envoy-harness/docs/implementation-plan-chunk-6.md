# Implementation plan — Phase A / Item 6 (plan mode)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (item 6) +
> [`implementation-plan.md`](./implementation-plan.md) ("Chunk 6.1 +
> Chunk 6.2 — plan state + /plan REPL command + runReview API").
>
> **Reference:** codex `codex-rs/tasks/plan/` + deepseek
> `plan-mode` (the "logged collaboration state" idea).
>
> **Status:** chunk 6.1 + 6.2 ship together as a single
> commit. The state primitive is hermetic; the
> commands + injection are thin orchestrators on top.

## Why this chunk

When the user gives a complex task ("build X, then Y,
then verify with Z"), the model often jumps to
implementation before agreeing on a plan. The result
is wasted work + a transcript full of half-done
changes. **Plan mode** lets the model work out a
plan first, get the user's sign-off, then execute.

The plan lives in **session state** (not on disk by
default). It's a structured record, not free text:
the user can `/plan edit` a section, `/plan show` to
review, `/plan approve` to start execution. Once
approved, the plan is injected as a **top-priority
bounded fragment** in the next model call so the
model has the plan in context.

`/review` hands the plan + the latest result to the
verifier (the existing v6 verifier). When the verifier
flags a gap, the host can route the gap back to plan
mode (a "review loop").

## Design choices (locked at chunk start)

### 1. `PlanState` record on the session

```ts
interface PlanState {
  /** `false` for an ordinary session; `true` once
   *  the user has entered plan mode. */
  active: boolean;
  /** The plan text. Free-form (the model writes
   *  whatever structure it wants). */
  planText: string;
  /** Lifecycle state. */
  reviewStatus: "draft" | "proposed" | "approved" | "rejected";
  /** When the plan was last updated (ISO 8601). */
  updatedAt: string;
}
```

**Why a discriminated union, not a "always-on"
flag:** a session can have `active: false +
reviewStatus: "draft"` (initial state) or
`active: true + reviewStatus: "approved"` (mid-
execution). The transitions are explicit:
`/plan enter` → `active: true, status: "draft"`,
`/plan propose` → `status: "proposed"`, `/plan
approve` → `status: "approved"`, etc.

### 2. State lives on `Session.metadata`

The `Session` interface already has
`metadata: SessionMetadata` (cwd, permissionMode,
title, startedAt). The plan state rides on the
metadata; it's not a separate top-level field
because the Session is the unit of persistence
(F14) — putting the plan in metadata means
`PersistedSession` already round-trips it for
free.

**Why not a separate `session.plan` field:** the
Session is a value object (immutable metadata
field, append-only messages). Adding a top-level
mutable field breaks that contract. The
`setPlan(state)` / `getPlan()` methods on the
session are the right shape.

### 3. `/plan` REPL commands

- `/plan enter` — set `active: true`, `status: "draft"`.
  Subsequent model calls see a system-prompt
  fragment: "you are in plan mode; produce a
  plan, do not make any changes".
- `/plan show` — print the current plan text.
- `/plan edit <text>` — set `planText` to `<text>`
  (the user can paste / type the plan).
- `/plan propose` — `status: "proposed"`. The model
  can be prompted (via a follow-up turn) to
  produce a plan; the user marks it as "ready for
  review".
- `/plan approve` — `status: "approved"`. Plan mode
  exits; the plan is injected as a top-priority
  fragment on the next turn.
- `/plan reject [reason]` — `status: "rejected"`
  + records the reason. Plan mode exits; the
  user re-enters plan mode for a fresh plan.
- `/plan exit` — `active: false` (without
  changing the status). Useful for "I want to
  keep the plan around but stop enforcing it".

The 7 subcommands are dispatched inside a single
`/plan` command (same pattern as `/memory`).

### 4. Plan injection as a top-priority fragment

When `active: true` AND `status: "approved"`, the
next model call sees a `ContextualUserFragment`
with:

```
ACTIVE PLAN (approved at <updatedAt>):

<planText>
```

The fragment has `priority: 1000` (higher than
memory fragments at 100). The model sees the
plan in the system-prompt region, alongside the
AGENTS.md content.

When `active: false` OR status is `draft` /
`proposed` / `rejected`, no plan fragment is
injected. The plan lives in the session metadata
but doesn't influence the model.

### 5. `runReview` API handoff (chunk 6.2)

`runReview(plan, result)` is a thin wrapper over
the existing verifier that takes a `PlanState` +
a result string and returns a `ReviewVerdict`.
Hosts wire it from their own UI (the Tauri
status bar, a CI step, etc.):

1. The host reads the current `PlanState` from
   the session.
2. The host calls `runReview(plan, result,
   { rules })` to hand the (plan, result) pair
   to the verifier.
3. The host renders the `ReviewVerdict` (one
   of `pass` / `partial` / `fail` / `disputed`).
4. On `disputed` or `fail`, the host suggests
   the user re-enter plan mode (a `/plan enter`
   is the right next step).

**Why an API, not a REPL command:** the
deepseek-style plan-vs-result review is
host-driven (the host decides when to invoke
it, with what rules). The REPL keeps `/review`
reserved for the F14.3 working-tree reviewer
(it would be confusing for `/review` to mean
"review the plan" in one session and "review
the diff" in another). The slash-command
namespace is finite; a capability seam
that's host-driven stays out of it.

The verifier rules are injected via the
`RunReviewOptions.rules` option (default:
`DEFAULT_RULES` — the existing v6 verifier's
default rules cover the "did the result match
the plan" check).

**Why not the deepseek "auto-loop" approach:**
deepseek's plan-mode retries the LLM until the
verifier passes (bounded by a max-iterations
parameter). envoy-harness keeps the
verifier + user as the loop: the model can
propose, the user can re-plan, the model can
re-execute. The LLM-as-loops pattern is a
future chunk (TBD when envoy-harness
introduces a host-injected retry policy).

### 6. `--plan` flag (chunk 6.2 wire-up)

The CLI's `--plan` flag is already parsed (v0
boilerplate; the agent runs in read-only mode
with a "produce a plan" system prompt). The
chunk wires it through:

- `RunOptions.plan: boolean` (already in argv).
- `Agent.run` injects the "you are in plan mode"
  fragment when `metadata.plan?.active === true`
  OR `--plan` is set on the one-shot path.
- The fragment is added to the system prompt
  region (the existing
  `agentOptions.systemPrompt` is merged with the
  plan-mode preamble).

**Backward compat:** the existing `--plan`
flag in argv (line 8 of `argv.ts`) is currently
a no-op in the runner. The chunk wires it.

## Files

### New

- `src/plan/state.ts` — `PlanState` interface +
  `createPlanState()` factory + `applyTransition()`
  state machine + `PlanTransitionError`. ~210 LoC.
- `src/plan/inject.ts` — `buildPlanFragment(state)`
  → `ContextualUserFragment` + `renderPlanText()`. ~80 LoC.
- `src/plan/review.ts` — `runReview(plan, result,
  { rules })` → `ReviewVerdict`. Thin shim over
  the existing verifier. ~145 LoC.
- `test/plan/state.test.ts` — hermetic tests for
  the state lifecycle. ~170 LoC, 16 tests.
- `test/plan/inject.test.ts` — fragment shape. ~90 LoC, 8 tests.
- `test/plan/review.test.ts` — verify happy +
  disputed paths. ~110 LoC, 6 tests.
- `test/plan/repl-plan.test.ts` — `/plan` REPL
  command tests (12 tests).

### Modified

- `src/session.ts` — `setPlan` / `getPlan` on
  `Session` + `SessionMetadata.plan?` field. ~43 lines.
- `src/session/persisted-session.ts` — `setPlan` /
  `getPlan` override + `rewriteHeader()` helper
  (shared with `setTitle`). ~35 lines.
- `src/cli/repl/commands-tier2-batch4.ts` —
  adds `/plan` REPL command (sub-arg dispatcher,
  7 subcommands). The file goes from 432 → 624
  LoC; still under the 800 hard cap, over the 500
  target (consistent with other v1.x files like
  `argv.ts` and `loop.ts`).
- `src/index.ts` — re-exports the new plan
  surface (`PLAN_FRAGMENT_PRIORITY`,
  `PlanTransitionError`, `applyTransition`,
  `buildPlanFragment`, `createPlanState`,
  `renderPlanText`, `runReview`, + 5 type aliases).
- `test/repl-tier2-batch4.test.ts` — updated
  shape tests for the 3-command batch (was 2).
- `test/repl-e2e.test.ts` — updated dispatch-table
  count: 27 → 28 built-in commands.

### Untouched

- The existing `compact.ts` + `budget.ts` (the
  plan fragment participates in the same
  bounded-fragment assembly as memories).
- The deepseek `interaction/user-questions` flow.
- The `--plan` CLI flag (already parsed but a
  no-op; wiring it is a future chunk).

## Test plan (hermetic)

### `state.ts` (16 tests, 4 describe blocks)

- `createPlanState()` returns the initial
  `active: false, status: "draft"` (2 tests).
- The valid transitions:
  - `enter` → `active: true, status: "draft"`.
  - `edit` (draft) → `draft` with text.
  - `edit` (rejected) → `draft` (re-edit after
    rejection).
  - `propose` → `proposed`.
  - `approve` → `approved`.
  - `reject` (with reason) → `rejected` +
    `rejectionReason` set.
  - `reject` (no reason) → `rejected` +
    `rejectionReason` undefined.
  - `exit` → `active: false` (preserves text +
    status).
- Invalid transitions throw:
  - `enter` on an active session.
  - `edit` on an inactive session.
  - `edit` on a proposed plan.
  - `approve` on a draft (must propose first).
  - `approve` on an approved plan (no re-approve).
  - `exit` on an inactive session.

### `inject.ts` (8 tests, 2 describe blocks)

- `buildPlanFragment` returns `[]` for:
  - `undefined` plan.
  - Inactive plan.
  - Draft plan (not approved).
  - Proposed plan (not approved).
  - Rejected plan (not approved).
  - Approved plan with empty text.
- `buildPlanFragment` returns a single fragment
  for active + approved + non-empty plan:
  - `id: "plan"`, `owner: "plan"`,
    `priority: 1000` (= `PLAN_FRAGMENT_PRIORITY`).
  - `estimatedTokens > 0`.
- `renderPlanText` includes the `updatedAt`
  timestamp + plan text + "ACTIVE PLAN" header.

### `review.ts` (6 tests)

- No plan → `fail` verdict with "use /plan
  first" suggestion.
- A plan with no text → `fail` verdict.
- A clean plan + clean result → `pass` verdict.
- A plan + result with "EACCES" → `partial`
  (the sandbox-respected rule flags it).
- A custom pass rule → `pass` verdict.
- A custom fail rule → `fail` verdict.

### `repl-plan.test.ts` (12 tests, 9 describe blocks)

- `/plan` (no args) → "no active plan" hint.
- `/plan enter` → activates plan mode; session's
  `getPlan()` returns `{ active: true,
  reviewStatus: "draft" }`.
- `/plan edit <text>` → sets the plan text.
- `/plan edit` (no text) → "usage: ..." error.
- `/plan show` (after edit) → prints the plan.
- `/plan show` (active but empty) → empty-plan
  hint.
- `/plan propose` + `/plan approve` → marks as
  approved; session's `getPlan()` returns the
  approved state.
- `/plan reject <reason>` → marks as rejected +
  sets `rejectionReason`.
- `/plan reject` (no reason) → bare rejected.
- `/plan exit` → leaves plan mode; text +
  status preserved.
- `/plan approve` before `/plan propose` →
  friendly error message (not a stack trace).
- `/plan bogus` → "usage: ..." error.

## Module-size check

`commands-tier2-batch4.ts` goes from 432 → 624
LoC (over the 500 target, under the 800 hard
cap). Consistent with the other v1.x files
already in that range (`argv.ts` 668, `loop.ts`
543, `lsp/stdio-client.ts` 702,
`agent/tool-executor.ts` 565). No new
allowlist entry needed.

## Success criteria

- `PlanState` lifecycle is correct (16 tests).
- `buildPlanFragment` returns the right shape
  (8 tests).
- `runReview` works for pass / partial / fail /
  custom rulesets (6 tests).
- `/plan` REPL command works end-to-end
  (12 tests).
- All existing tests still pass (1218 total
  passing + 3 live-API skipped after chunk 6).
- New tests: 42 (16 + 8 + 6 + 12).
- Module-size check: `commands-tier2-batch4.ts`
  at 624 LoC (under hard cap).
- `BUILTIN_TIER2_BATCH4_COMMANDS` now has 3
  commands (was 2); total REPL command count
  goes from 27 to 28.
