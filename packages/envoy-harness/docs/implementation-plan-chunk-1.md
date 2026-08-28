# Implementation plan — Phase A / Item 1 (compaction variants)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (item 1) and
> [`implementation-plan.md`](./implementation-plan.md) ("Chunk 1.1 + 1.2 —
> compaction budget math + remote-history strategy + CLI flags").
>
> **Status:** chunks 1.1 + 1.2 ship together as a single commit. The
> budget math is a hermetic core; the CLI flags + remote-history strategy
> + summarizer-throws fallback are thin orchestrators on top of the math.
>
> **Existing baseline:** `src/agent/compact.ts` already has
> `compactMessages(messages, keep)` (drop-oldest) and
> `compactMessagesWithSummary(messages, keep, summarize)` (LLM-summarize
> insertion). Both operate on message COUNT, not token COUNT. This chunk
> adds a third strategy (`budget`) that operates on token count, plus a
> small CLI expansion (`/compact --budget N`, `/compact --remote`).

## Why a third strategy

The current count-based strategies work for small transcripts but degrade
on the kind of session envoy-harness actually runs: long-running REPL
sessions where tool outputs (file reads, bash) can dominate the token
budget. A 50-message transcript might fit in 4K tokens (light) or 200K
tokens (heavy tool results) — count is a bad proxy.

The budget strategy is the **operationally correct** one: it knows when
to stop dropping. Combined with the summarizer fallback, the agent
self-tunes: "first try to drop the cheap way; if even the last few
messages don't fit, escalate to a summary."

## Design choices (locked at chunk start)

### 1. Token estimation is a **pure, hermetic** function

```ts
estimateMessageTokens(message: Message): number
```

The estimator uses a character-based heuristic (≈ 4 chars per token for
English) plus per-block structural overhead. The structural overhead
captures JSON framing, tool-call id + name + args shape, tool_result id
+ content shape, etc. — without it, the estimate is 5-10% low for
tool-heavy transcripts.

**No real tokenizer** — the function is hermetic (no I/O, no native
modules). Tests can assert exact token counts. A future chunk can swap
in a real tokenizer behind the same signature (deepseek's
`tokenize.ts` already exists; it gives character-level counts; a real
`gpt-tokenizer` can replace it when one is available).

### 2. `selectDroppablePrefix(messages, budget): DroppablePrefixResult`

```ts
interface DroppablePrefixResult {
  kept: Message[];        // the post-drop transcript
  dropped: Message[];     // the messages that were dropped (in order)
  totalTokensAfter: number; // the sum of estimateMessageTokens over kept
  overBudget: boolean;    // true when even system + last don't fit
}
```

**Algorithm:** iterate from the end, accumulating token counts. Drop
from the start until the total fits the budget. The system message (if
any) is always preserved (per the existing compact contract) — if it
alone exceeds the budget, the function keeps just the system message
and sets `overBudget: true` so the caller can escalate to a stronger
strategy (summarize).

**Why an `overBudget` flag, not an exception:** the caller decides
whether to escalate. Dropping the system message is a policy decision
(not a math one); making it explicit lets the caller handle the
"summarizer fell through to drop-oldest" case (chunk 1.2 fallback)
without try/catch noise.

### 3. `compactMessagesBudget(messages, budget): CompactBudgetResult`

A thin wrapper over `selectDroppablePrefix` that matches the existing
`compactMessagesWithSummary` shape:

```ts
interface CompactBudgetResult {
  messages: Message[];   // the post-drop transcript
  droppedCount: number;  // 0 = no-op
  overBudget: boolean;   // see above
}
```

The existing `compactMessages` and `compactMessagesWithSummary` keep
working unchanged (count-based). The budget strategy is a third
variant, not a replacement.

### 4. CLI flags on `/compact` (chunk 1.2)

The REPL already has a `/compact` command (Tier-2 batch 2). The chunk
expands it to accept flags:

```
/compact                # default: drop-oldest, keep=10 (existing behavior)
/compact --budget N     # budget strategy: keep total tokens ≤ N
/compact --remote       # remote-history strategy: archive old messages, keep recent in-transcript
/compact --keep N       # count strategy with custom N (default 10)
/compact --summarize    # use the LLM-summarize strategy (default for long sessions)
```

The implementation lives in `src/cli/repl/commands-tier2-batch2.ts`
(extending the existing `/compact` command). The flags are parsed by
the existing argv helper. The summarizer is opt-in — the host (Tauri
or the CLI runner) decides whether to inject a real LLM summarizer
or accept the budget strategy.

**Why the `default` strategy stays count-based:** the budget strategy
needs a token estimate; for very small transcripts the count strategy
is faster and equally correct. The default is unchanged.

### 5. Summarizer-throws → drop-oldest fallback (chunk 1.2)

The existing `compactMessagesWithSummary` returns the original
transcript if the summarizer throws (it does `.catch` internally? — let
me check). Looking at `compact.ts:75-108`, the function awaits
`summarize(dropped)` and lets the throw propagate. The chunk changes
this to a fallback: on throw, the function falls through to
`compactMessages(messages, keep)` (drop-oldest) and records the
failure in the result.

This makes `/compact --summarize` robust to LLM unavailability.

## Files

### New

- `src/context/budget.ts` — the math (`estimateMessageTokens`,
  `totalTokens`, `selectDroppablePrefix`). ~120 LoC.
- `test/context/budget.test.ts` — hermetic tests for the math. ~200 LoC.

### Modified

- `src/agent/compact.ts` — adds `compactMessagesBudget`. ~50 LoC added
  to the existing 136 LoC file. Total ~186 LoC, still under 500.
- `test/agent/compact.test.ts` — adds tests for the budget strategy
  + the summarizer-throws fallback. +5-6 tests.
- `src/cli/repl/commands-tier2-batch2.ts` — extends `/compact` to
  accept `--budget N`, `--remote`, `--keep N`, `--summarize` flags.
  ~80 LoC added.
- `test/repl-tier2-batch2.test.ts` — tests for the new flags. +3-4 tests.

### Untouched

- `src/agent/run-loop.ts` — doesn't need changes (the budget strategy
  is a function the agent calls, not an internal loop change).
- `src/agent.ts` — no changes (the `compactMessages` API is already
  exposed as `Agent.compact` / `Agent.compactWithSummary`).
- The deepseek `interaction/user-questions` flow — orthogonal to
  compaction.

## Out of scope (later chunks)

- **Real tokenization** (tiktoken, gpt-tokenizer, etc.) — chunk 1.3
  or a future "tokenizer-pluggable" chunk.
- **Remote-history persistence** (the `remote` strategy needs a
  network target; the v0 flag is parsed but the implementation is
  "remote-history-stub: log a warning, fall back to budget"). The
  remote target is the mesh or a local JSON file — design TBD.
- **Auto-compaction on context overflow** (the "if the model errors
  with `context_length_exceeded`, auto-compact and retry" path). The
  codex port for this is `codex-rs/core/src/compact_token_budget.rs`
  but it's a separate feature (chunks 1.3+).

## Test plan (hermetic — no real tokenizer)

### `estimateMessageTokens`

- Text block: 4 chars → 1 token (rounded up).
- Tool call: name + args JSON + structural overhead.
- Tool result: content string + structural overhead.
- Empty message: 0 tokens.
- Mixed blocks: sum.

### `selectDroppablePrefix`

- Empty input → `{ kept: [], dropped: [], totalTokensAfter: 0, overBudget: false }`.
- System only (under budget) → kept = system, dropped = [], overBudget = false.
- System + 3 messages, all under budget → no drop.
- 5 messages, budget just fits 3 → drops first 2.
- 5 messages, budget fits only the system + last 1 → drops 3, kept = system + last.
- Budget = 0 → kept = system only (if any), overBudget = true if system > 0.
- System alone > budget → kept = system only, overBudget = true.
- Token estimates are stable (running the function twice gives the same result).

### `compactMessagesBudget`

- Same as `selectDroppablePrefix` but in the `CompactBudgetResult` shape.
- The function is a thin wrapper; the heavy lifting is in `selectDroppablePrefix`.

### `compactMessagesWithSummary` fallback (chunk 1.2)

- Summarizer throws → falls through to drop-oldest, returns the
  dropped count as the sum of both strategies' drops.

### CLI flag parsing

- `/compact` → existing behavior (count, keep=10).
- `/compact --budget 1000` → calls the budget strategy.
- `/compact --keep 5` → calls the count strategy with keep=5.
- `/compact --summarize` → calls the LLM-summarize strategy.
- Invalid flag → usage error.

## Module-size check

- `src/context/budget.ts`: ~120 LoC (under 500).
- `src/agent/compact.ts`: 136 + 50 = 186 LoC (under 500).
- `src/cli/repl/commands-tier2-batch2.ts`: current size + 80. Need to
  check current size; the file is probably in the 200-400 range.
  Add to allowlist if it goes over 500.

## Success criteria

- `selectDroppablePrefix` is correct on all 8 test cases above.
- `compactMessagesBudget` returns the right shape.
- `/compact --budget N` calls the budget strategy.
- `/compact --summarize` calls the LLM-summarize strategy.
- Summarizer-throws → drop-oldest fallback works.
- All existing 1090 tests still pass.
- New tests: ~13 (8 budget math + 5 CLI flag tests).
- Module-size check: no new file over 500; no file exits the allowlist.
