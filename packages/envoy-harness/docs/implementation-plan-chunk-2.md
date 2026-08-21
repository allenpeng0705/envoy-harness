# Implementation plan — Phase A / Item 2 (memories)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (item 2) +
> [`implementation-plan.md`](./implementation-plan.md) ("Chunk 2.1 +
> Chunk 2.2 — memories").
>
> **Reference:** codex `codex-rs/memories/` (file-based
> progressive disclosure — `MEMORY.md`, `memory_summary.md`,
> `skills/<name>/SKILL.md`) + deepseek memories
> (retrieval discipline: small, greppable, on-demand).
>
> **Status:** chunk 2.1 ships the store + citations + bounded
> injection. Chunk 2.2 ships the consolidation at session end
> + the `/memory` REPL commands. Both ship together as a
> single commit (the store is a hermetic core; the commands
> + consolidation are thin orchestrators on top).

## Why this chunk

A long-running REPL session accumulates knowledge: user
preferences, repo conventions, "landmines", reusable
workflows. The model forgets all of it when the context
window compacts. **Memories persist knowledge across
sessions** — the next session sees what the previous one
learned.

The two halves of the design:

- **codex format** (file-based progressive disclosure):
  memories live as files in a `memories/` directory. A
  one-line `memory_index.md` lists all titles (always
  loaded, low token cost). Individual memories are loaded
  on-demand via the model's `read_file` tool when the title
  matches a query.
- **deepseek retrieval** (small + greppable + on-demand):
  each memory file is small (< 1K tokens), has a clear
  title, and is structured so the model can grep for
  keywords. Memories are NEVER pasted into the system
  prompt wholesale.

## Design choices (locked at chunk start)

### 1. Memory file format (codex-flavored)

A memory file is a markdown file under `memories/<name>.md`:

```markdown
---
tags: [typescript, codex, harness]
created: 2026-08-21
---

# Memory title (one line)

Body. Keep it short (< 1K tokens; the bounded fragment
will reject over-budget ones at construction).

Use code blocks for commands / paths / exact snippets.

## Optional subsections

For citations: `[memory:foo.md#Optional-subsection]`.
```

**YAML frontmatter** is optional but recommended for tags +
created date. The parser is lenient: missing frontmatter
is fine; tags default to `[]` and created defaults to
"unknown".

**`<name>.md`** is the canonical id. Names are
`[a-z0-9_-]+` (no slashes, no spaces). `MEMORY.md` and
`memory_summary.md` are reserved (per codex convention)
and NOT included in the index — they're a different
shape (handbook + summary), chunk 2.2 territory.

### 2. `MemoryStore` interface + `LocalMemoryStore`

```ts
interface MemoryStore {
  /** List all memory names (excluding the reserved
   *  handbook / summary files). */
  list(): Promise<MemoryMeta[]>;
  /** Read a single memory's full content. */
  read(name: string): Promise<Memory | undefined>;
  /** Write (or overwrite) a memory. Returns the
   *  stored metadata. */
  write(mem: Memory): Promise<MemoryMeta>;
}
```

`LocalMemoryStore` is the file-based implementation. The
`memoryRoot` is the directory the user passes (e.g.
`./memories` for a project, or `~/.envoy-harness/memories`
for a user-global store).

**Hermetic tests:** the tests use a `tempDir`-style fake
filesystem (the `node:fs/promises` `mkdtemp` API). No
real paths, no real writes to the user's home directory.

### 3. Citation parsing

The model cites a memory with `[memory:<name>]` (whole
file) or `[memory:<name>#<anchor>]` (a section heading,
slugified). The parser extracts the citation, the parser
is the inverse: a citation list `["memory:foo.md",
"memory:bar.md#Setup"]` is rendered back to a string the
model can read.

```ts
type MemoryCitation = {
  name: string;
  /** The slugified heading, or undefined for whole-file. */
  anchor?: string;
};

function parseCitation(text: string): MemoryCitation[];
function renderCitation(c: MemoryCitation): string;
```

**Why render too:** the model writes citations; humans
copy-paste them into emails. The render function ensures
the round-trip is stable.

### 4. Bounded injection (chunk 2.1)

A `buildMemoryIndex(store)` function returns a single
`ContextualUserFragment`:

```
Available memories (read with `read_file memory/<name>.md`):

- [typescript-harness] envoy-harness self-test conventions
- [mesh-bootstrap] How to bootstrap a fresh mesh node
- [mavis-style] Mavis's preferred code-review style
```

The model sees the list of titles + a one-line summary
per memory. To get the full content, the model calls
`read_file` with the path (the file is in `memories/`,
so the model can reach it via the existing `read_file`
tool).

**Why one fragment, not N:** a single fragment is easier
to reason about (one token cap, one priority). N fragments
would each compete in the assembly budget, leading to
"which 2 memories survived the budget?" confusion. The
index is the canonical "what memories exist" surface; the
model loads individual ones on demand.

### 5. Session-end consolidation (chunk 2.2)

A `consolidateMemories(store, session, opts)` function
that:

1. Asks the LLM for a JSON list of "memories worth
   saving" from the session transcript.
2. Dedups by hash: if a candidate memory's content hash
   matches an existing memory, skip.
3. Writes the new memories to the store.
4. Returns the list of added memories.

**The LLM call is opt-in:** the host passes a
`consolidate` function (just like `compactWithSummary`).
The store + dedup logic is hermetic; the LLM is the
host's responsibility.

**Why dedup by hash, not by semantic similarity:** the
host's LLM is the judge of "is this a new memory?". The
store only enforces "we don't store the same content
twice". A trivial `SHA-256` of the normalized body is
enough — semantic dedup is the LLM's job.

### 6. `/memory` REPL commands (chunk 2.2)

- `/memory list` — print all memory titles
- `/memory read <name>` — print a memory's full content
- `/memory add <name> <body>` — add a new memory
  (no LLM; the user provides the body)

The commands are bounded by the store's hermetic core
(no LLM, no network). The user is the judge of
quality.

## Files

### New

- `src/memories/store.ts` — `MemoryStore` interface +
  `LocalMemoryStore` + `MemoryMeta` / `Memory` types.
  ~180 LoC.
- `src/memories/citations.ts` — `parseCitation` +
  `renderCitation` + `MemoryCitation` type. ~80 LoC.
- `src/memories/inject.ts` — `buildMemoryIndex(store)` +
  `buildMemoryFragment(meta, body)` helpers. ~80 LoC.
- `src/memories/consolidate.ts` — `consolidateMemories`
  + the hash-dedup helper. ~120 LoC.
- `test/memories/store.test.ts` — hermetic tests
  (`mkdtemp` temp dir, fake store, parse + write).
  ~200 LoC.
- `test/memories/citations.test.ts` — citation parse /
  render round-trip. ~120 LoC.
- `test/memories/inject.test.ts` — fragment shape +
  budget enforcement. ~80 LoC.
- `test/memories/consolidate.test.ts` — hash-dedup +
  LLM-call integration. ~150 LoC.

### Modified

- `src/cli/repl/commands-tier2-batch3.ts` — adds the
  `/memory` command family. ~80 LoC added.
- `test/repl-tier2-batch3.test.ts` — tests for
  `/memory list` / `read` / `add`. +4 tests.
- `src/index.ts` + `src/memories/index.ts` — public
  surface re-exports.

### Untouched

- The existing `compact.ts` + `budget.ts` are orthogonal.
  Memories don't affect compaction directly (they go
  through the bounded-fragment path).
- The deepseek `interaction/user-questions` flow.

## Test plan (hermetic)

### `store.ts`

- `LocalMemoryStore.list()` returns the right `MemoryMeta[]`
  for a directory with 3 memories + a reserved `MEMORY.md`.
- `read(name)` returns the parsed body; missing name
  returns `undefined`.
- `write(mem)` overwrites; metadata reflects the write.
- YAML frontmatter is parsed; missing frontmatter is OK.
- Reserved filenames are filtered out of `list()`.
- Names with invalid characters are rejected at write
  time (not stored, error returned).

### `citations.ts`

- `[memory:foo.md]` → `{ name: "foo.md" }`.
- `[memory:foo.md#Setup]` → `{ name: "foo.md", anchor: "Setup" }`.
- Multiple citations in one string are extracted.
- A non-citation string returns `[]`.
- `renderCitation(parseCitation(x)) === x` for valid
  citations.

### `inject.ts`

- `buildMemoryIndex(store)` returns a fragment with
  the right `id` / `owner` / `estimatedTokens`.
- The fragment's `render()` returns a stable, parseable
  list (so the model can read it).
- An over-budget memory (rare; > 10K tokens) is rejected
  at construction with a clear error.

### `consolidate.ts`

- An empty session returns `{ added: [] }`.
- A session with the LLM returning an empty list returns
  `{ added: [] }` (the LLM has the no-op signal gate).
- A session with the LLM returning 2 memories, both new,
  writes both + returns both.
- A session with the LLM returning 1 memory whose hash
  matches an existing one → dedup, returns `[]`.
- A session where the LLM throws → `added: []` (fallback
  to "no memories written").

### `/memory` commands

- `/memory list` prints the titles.
- `/memory read foo` prints the body; missing name
  prints "not found".
- `/memory add foo body` writes a new memory.
- Invalid name (e.g. `MEMORY.md`) is rejected.

## Module-size check

All new files are under 500 LoC. The `consolidate.ts` is
the biggest at ~120 LoC. No allowlist additions needed.

## Success criteria

- `LocalMemoryStore` correctly reads + writes files in
  a hermetic temp dir.
- `parseCitation` + `renderCitation` round-trip.
- `buildMemoryIndex` returns a fragment the model can
  read (titles + one-line summary).
- `consolidateMemories` dedups by hash; LLM call is
  host-injected.
- `/memory` commands work end-to-end.
- All existing 1119 tests still pass.
- New tests: ~30 (split across 4 test files).
- Module-size check: no new file over 500.
