# Implementation plan — gap closure (Phase A)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (DRAFT v2, 2026-08-21).
> This doc is the executable sub-plan for **Phase A only** ("Loop & context",
> 1–2 weeks, items 1, 2, 5, 6). Later phases (B–G) get their own sub-plans
> when their turn comes.
>
> **Per-chunk discipline:** every chunk = one sub-plan doc + one commit.
> Locked design questions live in the chunk's sub-plan; the chunk ships
> the code + tests + a self-review commit.

## Why this doc

`gap-closure-plan.md` is the strategy: which gaps matter, in what order,
which existing packages we reuse, which standards we follow. It is
intentionally design-light — the executable chunking lives here.

## Phase A — Loop & context (1–2 weeks)

The four items that close the "powerful local agent" gap: compactions that
don't blow context, memories the model can cite, open-ended user questions,
logged plan state. All four are small, hermetic, no-mesh — they unblock the
agent's day-to-day power without touching distribution.

| # | Item | Chunks | Effort | Started |
|---|---|---|---|---|
| 1 | Compaction variants (budget / remote-history / fallback) | C1 budget math, C2 remote-history + CLI flags | M | next |
| 2 | Memories (codex format + deepseek retrieval discipline) | C1 store + citations, C2 consolidation + dedup | M | after 1 |
| 5 | Ask-user / elicitation (open-ended questions) | C1 service + REPL provider, C2 tool + approval delegation | S | **THIS PR** |
| 6 | Plan mode (logged collaboration state) | C1 plan state + /plan commands, C2 review handoff | S | after 5 |

Order rationale: **5 first** (smallest, no dependencies, sets the
"interaction surface" pattern for the other items), then **1** (compaction
is the most common failure mode in real usage), then **2** (memories build
on bounded fragments from item 1's budget math), then **6** (plan state
references memory + verification results — last in the phase).

## Chunk 5.1 — ask-user service + REPL provider (this commit)

**Goal:** one `UserQuestionService` interface + a default REPL provider.
No model-facing tool yet; that's chunk 5.2. The service stands alone so
chunk 5.2's tool is a thin wrapper + the existing approval flow can
delegate to it (item 5 design — "approval and ask_user share the service
so the human has a single interaction surface").

**Files (`src/interaction/`):**
- `user-questions.ts` — `UserQuestionRequest`, `UserQuestionAnswer`,
  `UserQuestionService` interface + `createUserQuestionService()` factory.
  One active provider at a time; `registerProvider(p)` returns a
  disposer. `ask(req)` is `AbortSignal`-aware. Empty-provider state
  returns a synthetic "no provider" answer (the model can fall through).
- `providers/repl-stdin.ts` — the default REPL provider. Reads a single
  line from stdin (or multiple lines when `multiline: true`, terminated
  by a sentinel like `"""` on its own line). `cancelled` mapping: EOF
  or `Ctrl+C` (when `signal` aborts) → `{ value: "", cancelled: true }`.
  The provider logs the answer to the REPL output so the user sees
  the echo.
- `index.ts` — re-export the public surface.

**Wire-up (minimal):** the Agent's constructor takes a new optional
`userQuestions?: UserQuestionService` field. When absent, no provider
is registered (chunk 5.2's tool + approval-delegate callsites fall
through to "no provider" answers). This keeps chunk 5.1 additive — no
existing Agent construction site needs to change.

**Tests (hermetic — no real stdin):**
- `providers/repl-stdin.test.ts` — fake `readline`-like interface
  (inject a `Readable` + capture `write` calls). Tests:
  - Single-line prompt → user types "yes" → answer `{ value: "yes" }`
  - EOF before answer → answer `{ value: "", cancelled: true }`
  - `signal.abort()` mid-prompt → answer `{ value: "", cancelled: true }`
  - Multiline mode: type 3 lines + `"""` sentinel → joined value
  - Multiline mode: EOF before sentinel → `cancelled: true`
  - `options: ["yes", "no"]` → user picks index 1 → `{ value: "no", optionIndex: 1 }`
- `user-questions.test.ts`:
  - No provider registered → `ask()` returns `{ value: "", cancelled: true }`
    (no throw; the model falls through to its default)
  - One provider registered → `ask()` delegates
  - Register → unregister → `ask()` returns no-provider answer
  - Register a second provider → throws (one-active-provider invariant)
  - `signal` already-aborted → `ask()` returns `cancelled: true` without
    delegating

**Hermetic contract:** every test uses a fake `Readable`/`Writable` pair
(pass `process.stdin`-shaped streams to the REPL provider's
constructor; default to a `Readable.from([])` + `Writable` that pushes
into an array). No real process, no real LLM, no live kernel.

**Module-size check:** new files land under the 500-line target. The
REPL provider is the biggest (~150 LoC); keep it under by extracting
the "options picker" prompt into a small helper if it grows.

**Out of scope (chunk 5.2):**
- `ask_user` model-facing tool
- Approval flow delegating to the service
- Tauri / mesh provider (adapter package, later)
- `/plan` command (item 6)

## Chunk 5.2 — ask_user tool + approval delegation (next commit)

**Goal:** wire the model-facing `ask_user` tool + the existing
`AskForApproval` flow into the same `UserQuestionService`. The human
sees one interaction surface — the REPL provider renders both "tool
needs your input" and "tool wants to do X, allow?" the same way.

**Design choices (locked at chunk start):**
- Approval delegation: `AskForApproval` becomes a thin shim that
  translates an approval request into a `UserQuestionRequest` (the
  prompt is "Allow {toolName} to {action}? [y/N]") and returns
  `cancelled` as "deny". Backward compat: the existing `Approval`
  interface is preserved; the new path is opt-in.
- `ask_user` tool: model-facing, single-`option` or `options[]`,
  optional `multiline`, optional `timeoutMs`. When the service has
  no provider, the tool returns a structured "no user channel
  available" answer so the model knows to fall through.
- `timeoutMs`: a `setTimeout` that aborts the signal; the provider
  treats the abort as `cancelled: true`.

## Later chunks (Phase A continued)

- **Chunk 1.1** — compaction budget math: `selectDroppablePrefix(messages, budget)`
  + a `budget` strategy variant alongside the existing `drop-oldest`
  and `summarize` variants. The summary block carries a
  `rollingSummaryKey` for idempotent re-compact. Adds
  `src/context/budget.ts` (the math) + extends
  `src/agent/compact.ts` (the strategy).
- **Chunk 1.2** — remote-history strategy + `/compact --budget N` /
  `--remote` CLI flags + summarizer-throws → drop-oldest fallback.
- **Chunk 2.1** — `src/memories/store.ts` (codex-format
  `memories/*.md` root) + `src/memories/citations.ts` (parse /
  render `[memory:file#anchor]`) + bounded injection as
  `ContextualUserFragment`s.
- **Chunk 2.2** — `consolidate.ts` (one-pass summarization at
  session end, dedup by hash) + `/memory` commands.
- **Chunk 6.1** — `src/plan/state.ts` (the `PlanState` record) +
  `/plan enter/show/edit/approve/reject/exit` + bounded injection
  as a top-priority fragment.
- **Chunk 6.2** — `/review` handoff: plan + result → verifier.

## Success criteria for Phase A (local scenario parity)

- Compaction: `/compact` (drop-oldest) and `/compact --budget N`
  (budget math) and `/compact --remote` (remote-history) all work;
  fallback path triggers when the summarizer throws.
- Memories: a session writes a memory on end; the next session reads
  it as a bounded fragment with citations; codex-format memory files
  load unchanged.
- Ask-user: a model calling `ask_user` gets a real human answer (or
  a clean "no provider" fall-through); `AskForApproval` delegates to
  the same service.
- Plan: `/plan enter` opens a logged state; the plan is injected as
  a high-priority fragment; `/review` hands the plan + result to
  the verifier.
- All hermetic: no mesh, no network, no live LLM, no real kernel
  in tests. Module-size CI stays green. `pnpm test` runs in < 30s.
