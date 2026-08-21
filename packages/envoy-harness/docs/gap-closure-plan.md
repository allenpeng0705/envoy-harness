# Gap-closure plan — envoy-harness vs codex / deepseek-harness

> **Status:** DRAFT v2 (2026-08-21). Input to `design.md` / `implementation-plan.md` —
> each item below becomes a design chunk with its own acceptance criteria and
> tests before it ships.
>
> **Phase progress (as of 2026-08-22):**
> - ✅ **Phase A** — Loop & context (items 1, 2, 5, 6) — **DONE** (4 commits on
>   `fix_gaps`: `15ad4b4` item 1, `798f757` item 2, `8404c8f`+`97c7a7e`+`28c7aae`
>   item 5, chunk 6 bundled into `1fe094f`/`0127c70`).
> - 🚧 **Phase B** — Runtime extensibility (items 3, 15) — code+tests done
>   (chunks 3.1–3.4 + 15.1/15.2; pending user commit). Cordis-compat
>   container deferred to Phase G.
> - ✅ **Phase C** — Environment & long-running (items 7, 8, 9, 13 P1) — **DONE**
>   (jobs / web / terminal + credentials wire; Brave search; `node-pty` optional;
>   `bash --job` sugar).
> - ✅ **Phase D** — Data & observability (items 14a, 14b P1, 16, 17) — **DONE**
>   locally 2026-08-22 (pending user commit). See
>   [`implementation-plan-phase-d.md`](./implementation-plan-phase-d.md).
> - ⏳ Phase E — Automation & embedding (items 10, 11).
> - ⏳ Phase F — OS sandbox (item 4).
> - ⏳ Phase G — Mesh-native integration (12, 13-adapter, 14b-remote, …).
>
> **Scenario contract:** envoy-harness runs either (a) locally and independently,
> or (b) as one node in EnvoyMesh collaborating with other nodes. Every item is
> rated for both scenarios. Package-1 code must never depend on EnvoyMesh
> internals (AGENTS.md invariant); mesh-specific pieces go in
> `@envoymesh/envoy-harness-adapter` (Package 3, EnvoyMesh repo).
>
> **License note:** envoy-harness (Apache-2.0) may port from codex (Apache-2.0)
> and deepseek-harness (MIT) with attribution. Directly reusable artifacts are
> called out per item.

## Principles (apply to every item)

1. **Package-1 boundary:** the harness core stays EnvoyMesh-free. Anything that
   touches a peer, node identity, or mesh transport lives in the adapter.
2. **Hermetic tests:** every new module is testable with mocks — no mesh, no
   network, no live LLM, no real kernel (fake providers are the default test
   surface).
3. **Module-size discipline:** new capability families are new modules/packages,
   never growth inside `agent.ts` (CI-enforced, allowlist).
4. **Additive public API:** existing seams (`MeshSubmitter`, hooks, verifier,
   config, session, trace) are extended, not replaced.
5. **Standards first, platforms second:** prefer open formats/protocols
   (SKILL.md, MCP, ACP, LSP, JSON-RPC hooks, JSONL sessions) over copying any
   single repo's runtime.

## Item map

| # | Capability | Recommendation | Effort | Phase | Status |
|---|---|---|---|---|---|
| 1 | Compaction variants | Follow codex (algorithm family) | M (2 chunks) | A | ✅ done (`15ad4b4`) |
| 2 | Memories | Hybrid: codex format + deepseek retrieval discipline | M (2–3 chunks) | A | ✅ done (`798f757`) |
| 3 | Plugins at runtime | **Invent** a capability-module seam; adopt deepseek contract shapes; curated Cordis-compat container later | L (3–4 chunks) | B | ✅ done (chunks 3.1–3.4 pending commit; Cordis-compat deferred to Phase G) |
| 4 | OS sandbox kernels | Reuse deepseek's published landlock-run npm family (Linux) + seatbelt (macOS) | M (2 chunks) | F | ⏳ |
| 5 | Ask-user / elicitation | Follow deepseek interaction/user-questions | S–M (1–2 chunks) | A | ✅ done (`8404c8f` + `97c7a7e` + self-review `28c7aae`) |
| 6 | Plan | Follow deepseek plan-mode (logged collaboration state) | S (1 chunk) | A | ✅ done (pending commit) |
| 7 | Background jobs | Follow deepseek jobs family contract | M (2 chunks) | C | ✅ done (L3 + bash --job sugar) |
| 8 | Web search / fetch | Follow deepseek web family (provider seam) | M (2 chunks) | C | ✅ done (HTTP fetch + Brave) |
| 9 | Persistent PTY / terminal | Follow deepseek terminal family | M (2 chunks) | C | ✅ done (fake + optional node-pty) |
| 10 | Automation protocol | Follow deepseek ACP server | M (2 chunks) | E | ⏳ |
| 11 | SDK / embedding | Follow deepseek JSON-RPC SDK + TS client; Python later | M (2 chunks) + L (py) | E | ⏳ |
| 12 | TUI / rich UI | Follow codex TUI *design*, but build in EnvoyMesh's Tauri host, not the core | REPL S; Tauri L | G | ⏳ |
| 13 | Secrets / credentials / keyring | Hybrid: deepseek-style provider seam in P1; mesh credentials in the adapter | M (2 chunks) | C/G | ✅ P1 done (adapter deferred) |
| 14a | Session query / history search | Follow deepseek session-query | M (2 chunks) | D | ✅ done |
| 14b | Cross-machine resume | Follow deepseek durable-session projection (simpler than codex rollouts) | M (2 chunks) | D/G | ✅ P1 done (remote → mesh adapter) |
| 15 | External config import | Both: codex-style importers + deepseek-style hook bridges | S–M (1–2 chunks) | B | ✅ chunks 15.1 + 15.2 done (pending user commit) |
| 16 | Feedback loop | Follow deepseek feedback family, wired into verifier/self-evolution | M (2 chunks) | D | ✅ done (signals helper; self-evolve hook light) |
| 17 | Observability | Follow deepseek runtime-diagnostics + telemetry sink seam | M (2 chunks) | D | ✅ done |

## Phases

- **Phase A — Loop & context** (1–2 weeks): 1, 2, 5, 6. Unblocks the agent's
  day-to-day power. **✅ DONE** (2026-08-21).
- **Phase B — Runtime extensibility** (1–2 weeks): 3, 15. Foundation for C/D/E.
  **🚧 in progress** — item 15 chunk 1 (codex config importer) +
  chunk 2 (deepseek `cordis.yml` + CC hooks.json + deepseek codec)
  + item 3 chunks 1, 2, 3, 4 (capability-module seam + 3 sample plugins
  + per-plugin config + zod-validated configs) all shipped locally
  (pending user commit). 1404 tests passing. The Cordis-compat
  container lands in Phase G.
- **Phase C — Environment & long-running** (2–3 weeks): 7, 8, 9, 13 (P1 part).
  Depends on B. **✅ DONE** (2026-08-22) — jobs/web/terminal + credentials
  wire, Brave search, optional `node-pty`, `bash --job` sugar.
- **Phase D — Data & observability** (2 weeks): 14a, 14b (P1 part), 16, 17.
  **✅ DONE** locally 2026-08-22 (pending user commit).
- **Phase E — Automation & embedding** (1–2 weeks): 10, 11. Depends on A + B.
- **Phase F — OS sandbox** (1 week): 4. Independent; needs a Linux CI job.
- **Phase G — Mesh-native integration** (continuous): 13 (adapter), 14b (remote
  transport), distributed skills/memory/jobs, 12 (Tauri UI), Cordis-compat
  container (if justified). Depends on EnvoyMesh v2.2 transport.

---

# Extension reuse strategy (deepseek / codex / other harnesses)

## Why this needs its own section

"Reuse extensions" is ambiguous across three very different extension models.
Before designing item 3, we verified what each ecosystem's extensions actually
are:

- **Deepseek plugins** are **Cordis plugins**: `apply(ctx, config)` on a Cordis
  `Context`, `inject: ['tools', 'skills', ...]`, config via `schemastery`,
  scope/layer semantics, peer dependencies on `@deepseek-ai/*` workspaces
  (Cordis itself is vendored under `vendor/`). Verified in
  `packages/jobs/jobs-local/src/index.ts` (imports `Context from
  '@deepseek-ai/cordis'`, `ScopedLayers`, `scopeOf`) and
  `packages/skill/tool-skill/package.json` (peer deps on `dsh-agent`,
  `dsh-skill`, `dsh-tools`, `cordis`).
- **Codex extensions** are skills (`SKILL.md` markdown), Rust-native plugins
  (`plugin` crate), hooks (`hooks.json`, JSON-RPC over stdio), and memories
  (markdown). Only the non-Rust surfaces are portable.
- **Claude Code extensions** are hooks (same JSON-RPC family), `CLAUDE.md`,
  and JS plugins under `.claude/plugins` (hooks + slash commands) — JS, so
  conceptually loadable, but not on any near-term path.
- **Universal standards:** SKILL.md (codex + deepseek both read it), MCP
  (language-agnostic), ACP (automation clients), LSP, AGENTS.md/CLAUDE.md
  conventions, JSONL session logs.

## Reuse taxonomy — five layers

| Layer | What it is | Examples | envoy-harness action |
|---|---|---|---|
| **L0 — Formats & standards** | Open specs both ecosystems use | SKILL.md, AGENTS.md, MCP, ACP, LSP, JSON-RPC hooks, JSONL sessions | Implement against the standard; interoperate with everyone |
| **L1 — Published artifacts** | Installable packages that are not platform-coupled | deepseek `landlock-run` npm family, `node-pty`, third-party MCP servers, E2B SDK | Direct dependency behind a seam |
| **L2 — Copyable code** | MIT/Apache code worth porting with attribution | deepseek `hook-protocol` codec, skill-file parsing, session-query indexing, ACP protocol mapping | Port; cite source; keep license headers |
| **L3 — Contract ports** | Deepseek capability contracts implemented natively over envoy seams | `ctx.jobs`, `ctx.skills`, `ctx.terminals`, `ctx.web`, `ctx.credentials`, `ctx.userQuestions`, `ctx.sessionQuery` | Adopt the type shapes + lifecycle; implement over envoy's session/hooks/tools/config |
| **L4 — Runtime plugin adapters** | Hosting another platform's plugins inside envoy | A curated whitelist of Cordis plugins (skill-filesystem, jobs-local, credentials-local) | `envoy-harness-cordis` compatibility container (experimental, Phase G) |
| **L5 — Wire-level reuse** | Cross-process/cross-node extension | A mesh node hosting a plugin exposed via MCP/ACP to other nodes | Adapter/transport concern |

**Rule of thumb:** do L0 → L1 → L3 first (they deliver most value with least
coupling). L4 only when a concrete high-value plugin cannot be ported. L5 rides
the v2.2 remote-submitter transport.

## Deepseek package feasibility matrix

Verified against the actual repo (`packages/*`):

| Deepseek package | Cordis-coupled? | Reuse path | envoy value |
|---|---|---|---|
| `native/landlock-run` (npm family) | No (standalone launcher) | **L1 direct dep** | Linux sandbox backend (item 4) |
| `hooks/hook-protocol` | Yes (peer: dsh-shell/session) | **L2 copy codec** | JSON-RPC hook runner (item 15) |
| `skill/skill-filesystem` | Partial (registry API only) | **L2/L3** — port SKILL.md parsing | Skill loader (item 3) |
| `skill/tool-skill` | Yes (needs agents/tools/skills ctx) | **L3** — port contract | Model-facing `skill` tool |
| `jobs`, `jobs-local` | Yes | **L3** — port contract | Background jobs (item 7) |
| `terminal`, `terminal-bash`, `tool-terminal` | Yes | **L3** — port contract + node-pty (L1) | PTY (item 9) |
| `web`, `web-search-*` | Yes | **L3** — port contract; providers are thin API wrappers | Web (item 8) |
| `credentials`, `credentials-local`, `authorization` | Yes | **L3** — port contract | Secrets (item 13) |
| `session-query` | Yes | **L3** — port contract + sqlite (L1) | Search (item 14a) |
| `plan-mode` | Yes | **L3** — port contract | Plan (item 6) |
| `interaction/user-questions` | Yes | **L3** — port contract | Ask-user (item 5) |
| `feedback` family | Yes | **L3** — port contract | Feedback (item 16) |
| `acp`, `sdk` | Yes | **L2** — protocol is standard; copy mapping | ACP/SDK (items 10–11) |
| `e2b` | Partial | **L1** (E2B SDK) + **L3** composition | Remote sandbox (item 4) |
| Any other Cordis plugin | Yes | **L4** shim only, whitelist | — |

## Codex reuse table

| Codex surface | Portable? | envoy action |
|---|---|---|
| `skills` (SKILL.md) | Yes | L0 loader (item 3) |
| `AGENTS.md` discovery | Yes | **Already adopted** (`src/agents-md/`) |
| Hooks JSON-RPC protocol | Yes | L0/L2 hook runner (item 15) |
| Memories (markdown + citations) | Yes | L0/L2 format adoption (item 2) |
| Context fragments + token budgets | Yes | **Already adopted** (`src/context/fragment.ts`); finish assembly (item 1) |
| Compaction algorithms | Yes (pure logic) | L3 port (item 1) |
| `plugin` / `core-plugins` (Rust) | No | Not reusable |
| TUI, app-server, cloud | No (product layer) | Do not copy |

## The Cordis-compat container (L4) — design

**Goal (optional, Phase G):** host a *curated whitelist* of deepseek Cordis
plugins inside envoy-harness so "reuse deepseek extensions" is literally true
for the highest-value plugins, not just contract ports.

**Where it lives:** a separate package `@envoymesh/envoy-harness-cordis` (or a
`src/compat/cordis/` module) — never in the Package-1 critical path. It depends
on the vendored `@deepseek-ai/cordis` types + the whitelisted `@deepseek-ai/*`
packages at pinned versions.

**Minimal Context facade** (the subset deepseek plugins actually touch):

```ts
interface CordisCompatContext {
  // envoy-native backends, Cordis-shaped
  tools: { register(tool: CordisTool): Disposable };
  skills: SkillRegistryCompat;        // wraps src/skills
  jobs: JobRegistryCompat;            // wraps src/jobs
  terminals: TerminalRegistryCompat;  // wraps src/terminal
  web: WebProviderRegistryCompat;     // wraps src/web
  credentials: CredentialsCompat;     // wraps src/credentials
  session: SessionCompat;             // wraps SessionStore
  model?: ModelAdapterCompat;         // optional
  // lifecycle
  inject(keys: string[]): Record<string, unknown>;
  dispose(): Promise<void>;           // ordered composite teardown
}
```

**Loader rules:**
1. Scan `~/.config/envoy-harness/capabilities/` and `.envoy/capabilities/`.
2. Accept only packages whose manifest lists a single `apply(ctx, config)`
   export **and** whose declared `inject` keys are in the whitelist.
3. **Audit checklist per plugin** (documented in the container README):
   - No use of Cordis fibers/`fork` outside the whitelist.
   - No `scope`/layer mutation beyond the documented registry writes.
   - No direct `ctx.model` streaming assumptions (envoy adapters differ).
   - No reliance on Cordis event-bus semantics not present in envoy hooks.
4. Reject anything failing the audit; the container never degrades into a
   "load anything and hope" loader.

**Startup whitelist (max 3):** `skill-filesystem` (if the L0 loader doesn't
cover it), `jobs-local`, `credentials-local`. Each gets a behavior-parity test
against its envoy-native counterpart; a plugin is dropped if parity can't be
held.

**Risks & mitigations:**
- Version drift (`@deepseek-ai/*` moves fast) → pin versions, lockfile in the
  container package.
- Untested ctx surfaces → the audit checklist + parity tests are the gate.
- Scope-layer semantics → the container implements only the documented
  registry read/merge behavior; anything deeper is rejected.
- Maintenance cost → this is why L4 is *last* and *optional*; L3 contract
  ports are the default answer.

**Recommendation:** ship L0 (SKILL.md), L1 (landlock-run, node-pty), and L3
(contract ports) first. Defer L4 until a real user asks for a specific deepseek
plugin that L3 cannot cover. This keeps "reuse deepseek" real without adopting
Cordis as a platform.

## SKILL.md loader — the standard-first extensibility path (design)

Both codex and deepseek load `SKILL.md` markdown; the emerging Agent Skills
spec uses the same shape. One loader makes envoy-harness compatible with all of
them.

**Module layout (`src/skills/`):**

```ts
// types.ts
interface SkillSummary {
  name: string;               // kebab-case
  description: string;
  whenToUse?: string;
  provider: string;           // "filesystem" | "embedded" | "mesh"
  invocation: { modelInvocable: boolean; userInvocable: boolean };
}
interface SkillDefinition extends SkillSummary {
  resourceBase: string | URL;
  instructions: string;       // parsed body of SKILL.md
}
interface SkillProvider {
  name: string;
  list(opts: { cwd: string; signal: AbortSignal }): Promise<SkillSummary[]>;
  get(name: string, opts: { cwd: string; signal: AbortSignal }): Promise<SkillDefinition>;
}

// registry.ts — registerProvider / list / get / snapshot, layers like deepseek
// fs-provider.ts — project roots (.envoy/skills), user roots, ~/.agents/skills
// frontmatter.ts — SKILL.md frontmatter parser (name, description, whenToUse, metadata)
// render.ts — renderSkillContent(): canonical <skill_content> block (deepseek shape)
// tool-skill.ts — model-facing `skill` tool
// catalog.ts — catalog projection as a bounded ContextualUserFragment + digest
```

**Catalog behavior (deepseek pattern):** at each `PreToolUse`/session start,
`snapshot()` the registry for the cwd; publish the catalog as a durable
user-role bounded fragment (name + description only — never bodies); on
membership/description change, publish a full replacement; the model loads a
skill via the `skill` tool and receives the canonical `<skill_content>` block.
Digest-based refresh so catalog churn never causes cache misses.

**Compatibility notes:**
- Codex skill roots (`~/.codex/skills`, project `.codex/skills`) can be
  scanned read-only by an optional provider — zero migration.
- Deepseek skill roots (`~/.dsh/skills`, `~/.agents/skills`) likewise.
- The loader is the model-facing half of item 3; the capability-module seam is
  the code-facing half. Both share the `CapabilityContext`.

---

# Item detail

## 1. Compaction variants — follow codex

**Reference:** codex `core/src/compact.rs`, `compact_token_budget.rs`,
`compact_remote*.rs`, `compact_model_fallback.rs`, `thread_rollout_truncation.rs`.

**Design (`src/context/budget.ts` + extend `src/agent/compact.ts`):**

```ts
type CompactionStrategy =
  | { kind: "drop-oldest"; keep: number }
  | { kind: "summarize"; keep: number; summarize: SummarizeFn }
  | { kind: "budget"; tokenBudget: number; summarize: SummarizeFn }  // NEW
  | { kind: "remote-history"; keep: number; summarize: SummarizeFn }; // NEW

// budget.ts
estimateTokens(message: Message): number;           // reuse src/tokenize.ts
selectDroppablePrefix(messages, budget): { drop: Message[]; keep: Message[] };
rollingSummaryKey(summary: string): string;          // for idempotent re-compact
```

- **Budget strategy:** keep newest messages intact; drop+summarize the oldest
  prefix until `estimateTokens(kept) <= tokenBudget`; the summary becomes a
  bounded fragment (reuses `createBoundedFragment`).
- **Remote-history:** the summary block carries a `rollingSummaryKey`; compact
  of a compact merges old + new summaries instead of double-summarizing.
- **Model fallback:** promoted from the REPL into the strategy (summarizer
  throws → drop-oldest with a trace event).
- **CLI:** `/compact --budget <tokens>` and `/compact --remote`.

**Chunks:** C1 budget math + `budget` strategy; C2 remote-history + fallback +
CLI flags.
**Tests:** budget boundary (exact/over/under), summary idempotency, fallback
path, system-message preservation (existing edge), persisted-session
round-trip.
**Mesh angle:** a worker's compaction quality becomes scoreboard-visible once
fragments carry `estimatedTokens` (compaction that silently loses context can
be penalized).

## 2. Memories — hybrid (codex format + deepseek retrieval)

**Reference:** codex `memories/write` + `memories/read` (markdown + citations);
deepseek `session-query` (authorized retrieval).

**Design (`src/memories/`):**

```ts
// store.ts — MemoryStore: user memory files (markdown), session consolidations
//   root: ~/.config/envoy-harness/memories/ (codex-compatible layout:
//   memories/*.md, extensions/ subdir, citations as [memory:file#anchor])
// consolidate.ts — on SessionEnd: one summarizer call → append
//   decisions / file paths / open questions to memory.md (dedup by hash)
// inject.ts — read path: memories → bounded ContextualUserFragment(s) with
//   citations; cap total by fragment budget; only when the user opts in
// citations.ts — parse/render [memory:...] citations (codex syntax)
```

**Rules:**
- Memory never enters context raw — always through bounded fragments with
  citations.
- Consolidation is one-pass in v1 (no Phase-1/Phase-2 pipeline); runs at most
  once per session end and is skippable (`/memory off`).
- Retrieval seam (deepseek): `SessionQueryService` (item 14a) is the
  *authorized* search over sessions; memories are the *curated* layer on top.

**Chunks:** C1 store + citations + bounded injection; C2 consolidation +
`/memory` commands + dedup; C3 (optional) memory extensions.
**Tests:** citation rendering, injection caps, dedup, consent gating, format
compatibility (parse a codex-format memory file).

## 3. Plugins at runtime — invent the seam; reuse contracts; defer Cordis shim

**Two halves:**

**(a) Capability-module seam (default path):**

```ts
// src/capabilities/types.ts
interface CapabilityContext {
  config: ConfigLayer;
  hooks: HookRegistry;
  tools: ToolRegistry;
  session: SessionStore;
  trace: Tracer;
  cost: CostTracker;
  submitter?: MeshSubmitter;
  skills: SkillRegistry;         // item 3b
  jobs?: JobRegistry;            // item 7 (registered if present)
  terminals?: TerminalRegistry;  // item 9
  web?: WebProviderRegistry;     // item 8
  credentials?: CredentialsProvider; // item 13
}
interface CapabilityModule {
  name: string;
  version: string;
  activate(ctx: CapabilityContext): Promise<Disposable>;
}
// src/capabilities/loader.ts — scan ~/.config/envoy-harness/capabilities/
//   and .envoy/capabilities/; validate manifest; isolate failures (a crashing
//   capability disables itself, not the agent)
```

Loader runs at session start; `/capabilities` lists active modules;
`/capabilities reload` is idempotent. Modules are ESM files with a manifest
export — no build step.

**(b) SKILL.md loader** (L0, standard) — see the dedicated design above.
Skills are the model-facing extension surface; capability modules are the
code-facing surface. Skills ship first.

**(c) Cordis-compat container (L4, Phase G, optional)** — see the reuse
strategy section. Whitelist-only; never the default path.

**Chunks:** C1 skill registry + filesystem provider + frontmatter; C2 `skill`
tool + catalog fragment + `/skills`; C3 capability-module seam + loader +
`/capabilities`; C4 (optional) Cordis container.
**Tests:** lifecycle, failure isolation, idempotent reload, catalog digest,
SKILL.md compatibility fixtures from codex + deepseek roots.

## 4. OS sandbox kernels — reuse deepseek landlock-run (Linux), seatbelt (macOS)

**Investigation result:** codex sandboxes are Rust crates (seatbelt/bwrap/
landlock/Windows) — not reusable. Deepseek publishes **`landlock-run` as a
three-package npm family (MIT)** — a self-restrict-then-exec launcher with
platform packages as optional deps; directly installable from TS.

**Design (`src/sandbox/backends/`):**

```ts
// landlock.ts — LandlockSandboxExecutor: spawn `landlock-run` (npm dep) with
//   a policy derived from SandboxPolicy (writable roots, readonly grants,
//   network off); Linux-only; NoopSandboxExecutor elsewhere until CI covers it
// seatbelt.ts — SeatbeltSandboxExecutor: spawn `sandbox-exec -p <profile>`
//   (macOS); generate the profile from SandboxPolicy
// policy.ts — SandboxPolicy → launcher args/profile translation (the only
//   place sandbox policy meets kernel syntax)
```

Selection: existing resolution algorithm in `src/sandbox/index.ts` picks the
best available backend per platform. Windows keeps the 6 bash validators
(job-object sandbox deferred).

**Chunks:** C1 landlock backend + policy translation + Linux CI smoke job;
C2 seatbelt backend + macOS opt-in integration test.
**Tests:** policy→args translation tables, fake launcher, backend selection,
Linux CI smoke (real landlock, marked live), failure-to-launch fallback.

## 5. Ask-user / elicitation — follow deepseek

**Reference:** deepseek `interaction/user-questions` (`ctx.userQuestions`) +
multiline support.

**Design (`src/interaction/`):**

```ts
// user-questions.ts
interface UserQuestionRequest { prompt: string; options?: string[]; multiline?: boolean; timeoutMs?: number; }
interface UserQuestionAnswer { value: string; optionIndex?: number; cancelled?: boolean; }
interface UserQuestionService {
  registerProvider(p: UserQuestionProvider): () => void; // one active provider
  ask(req: UserQuestionRequest): Promise<UserQuestionAnswer>;
}
// providers: repl-stdin.ts (default), tauri.ts / mesh.ts (adapter, later)
// ask-user-tool.ts — model-facing ask_user tool
// approval.ts — AskForApproval delegates to the same service
```

**Rules:** one provider per context; `ask` is abortable; REPL provider supports
multiline (paste mode); approval and ask_user share the service so the human
has a single interaction surface.
**Tests:** fake provider, single-provider enforcement, timeout/abort, multiline
round-trip, approval delegation, cancelled-answer mapping.

## 6. Plan — follow deepseek plan-mode

**Reference:** deepseek `plan-mode` (logged per-agent collaboration state).

**Design:** plan state on the session (extends `SessionMetadata`):

```ts
interface PlanState { active: boolean; planText: string; reviewStatus: "draft" | "proposed" | "approved" | "rejected"; }
```

`/plan` commands (enter/show/edit/approve/reject/exit); `--plan` (existing
read-only flag) maps to `active: true`; plan injected as a bounded fragment at
the top of the transcript while active; `/review` hands the plan + result to
the existing verifier.
**Tests:** state transitions, persistence across `/compact` and session
restore, guidance injection, review handoff.
**Mesh angle:** a worker's `PlanState` rides the chain subtask envelope; the
verifier sees plan vs result.

## 7. Background jobs — follow deepseek jobs family

**Status:** ✅ done (2026-08-22). See
[`implementation-plan-phase-c.md`](./implementation-plan-phase-c.md).

**Reference:** deepseek `jobs` + `jobs-local` + `tool-jobs` contract
(registry, owner-fenced ids, snapshots, observe/cancel/wait/completion).

**Shipped (`src/jobs/`):**
- `JobRegistry` / `JobHooks` / `JobSnapshot` (owner = opaque session id)
- `createLocalJobRegistry` — concurrency cap, kill→stopping, wait timeout
- `createProcessJobHooks` — child-process producer with bounded output
- Tools: `job_start` / `job_status` / `job_output` / `job_wait` /
  `job_kill` / `job_list`
- Hermetic tests: lifecycle, owner fence, limit, wait timeout, onJobDone

**Deferred:** mesh-remote `JobHandle`.

## 8. Web search / fetch — follow deepseek web family

**Status:** ✅ done (2026-08-22). See
[`implementation-plan-phase-c.md`](./implementation-plan-phase-c.md) +
[`implementation-plan-phase-d.md`](./implementation-plan-phase-d.md).

**Reference:** deepseek `web` (provider-neutral registration/selection) +
`web-search-*` providers.

**Shipped (`src/web/`):**
- Split `WebSearchProvider` / `WebFetchProvider` on one `WebRuntime`
- Selection: configured id → unique available → else errors
  (`PROVIDER_MISSING` / `UNAVAILABLE` / `AMBIGUOUS`)
- `createHttpFetchProvider` — keyless, size-capped HTTP(S) fetch
- `createBraveSearchProvider` — Brave Search API behind credentials/env
- Tools: `web_search` / `web_fetch`
- Hermetic tests: selection, truncation, duplicates, no-provider, mocked Brave

**Deferred:** paid search providers (exa/perplexity); MCP alternate path
already exists.

## 9. Persistent PTY / terminal — follow deepseek terminal family

**Status:** ✅ done (2026-08-22) with fake backend + optional `node-pty`.

**Reference:** deepseek `terminal` (`ctx.terminals`: backend registry,
branded ids, exact-Agent ownership, session ops) + `terminal-bash` +
`tool-terminal`.

**Shipped (`src/terminal/`):**
- `TerminalSessionService` — backend registry, `pty-N` ids, owner fence
  (owner = opaque session id, not live Agent instance)
- Exclusive send per session (`SEND_ACTIVE`)
- `createFakeTerminalBackend` for hermetic tests + CLI fallback
- `createPtyTerminalBackend` / `isPtyAvailable` (optionalDependency)
- Tools: `terminal_open` / `terminal_send` / `terminal_read` /
  `terminal_signal` / `terminal_close` / `terminal_list`
- Hermetic tests: ownership, duplicate backend, send exclusivity,
  list/kill, tool happy path, pty availability

**Deferred:** mesh-remote terminal.

## 10. Automation protocol — follow deepseek ACP server

**Reference:** deepseek `acp` (Agent Client Protocol over JSON-RPC stdio).

**Design (`src/protocol/acp.ts` + `src/protocol/jsonrpc.ts`):** one JSON-RPC
codec (framing, request/response, notifications) shared with the SDK (item 11).
Methods: `initialize` (version, capabilities: no editor/fs/terminal), optional
no-op `authenticate`, `session/new`, `session/prompt` (text + inline images,
one in-flight per session), `session/cancel`, `session/update` (committed
messages only — no token-by-token leakage), `session/request_permission`
(one-shot allow/reject). Reuses the Agent + session seams; permission requests
map to the existing approval flow.

**Chunks:** C1 JSON-RPC codec + ACP server skeleton; C2 session/prompt + cancel
+ permission + committed delivery.
**Tests:** scripted stdio pair (pattern of `test/mcp-stdio.test.ts`),
protocol conformance, cancellation races, permission one-shots, image
integrity (later).

## 11. SDK / embedding — deepseek JSON-RPC, TS first

**Design:** one JSON-RPC protocol (same codec as ACP) with an SDK surface:
`session/create`, `session/prompt`, `session/events`, `session/cancel`,
`config/get`, `tools/list`. Deliverables:
- `packages/envoy-harness-client` (TS, in this repo) — `EnvoyHarnessClient`
  over stdio, typed events.
- ACP and SDK share the transport; ACP is the automation dialect, SDK is the
  embedding dialect.
- Python SDK: separate published package, only when a consumer exists
  (EnvoyMesh nodes are TS; no Python consumer today).

**Tests:** client/server round-trip, framing, error mapping, cancel, event
ordering.

## 12. TUI / rich UI — codex TUI design, EnvoyMesh Tauri host

**Decision:** Package 1 stays UI-free. The rich UI is the existing EnvoyMesh
Tauri app (`EnvoyMesh/apps/tauri`), consuming the harness via the ACP/SDK
surface — bottom-pane composer, transcript view, approval surface, slash
palette (codex TUI design, mesh-native host). In-repo stopgap: REPL upgrades
(multiline paste, diff highlighting for `/diff`, scoreboard tables for
`/scoreboard`).
**Tests:** REPL upgrades are hermetic; Tauri UI has its own e2e lane in
EnvoyMesh.

## 13. Secrets / credentials / keyring — hybrid, boundary-respecting

**Status:** ✅ P1 done (2026-08-22). Mesh adapter part remains Phase G.

**Package 1 (`src/credentials/` + wire):**

```ts
interface CredentialReference { name: string; source: "env" | "file" | "ask" | "mesh"; }
interface CredentialsProvider {
  resolve(ref: CredentialReference, opts: { signal: AbortSignal }): Promise<string>;
  list(): CredentialReference[];
}
// providers: env.ts, file.ts (JSON 0600), ask.ts (via user-questions)
// redaction.ts — TraceSink wrapper that redacts resolved values
// wireEnvironmentTools creates the cascade and returns credentials
```

**Adapter (Package 3):** per-peer API keys, node identity (Ed25519 exists),
signed-envelope credentials. Mesh secrets never enter Package 1.
**Tests:** resolution order, ask flow, redaction, file permission check,
wire registration of Brave when env key present.

## 14a. Session query / history search — follow deepseek session-query

**Status:** ✅ done (2026-08-22).

**Shipped (`src/session/query.ts` + `src/session/indexer.ts`):** index
persisted JSONL sessions; `SessionQueryService.search` by role / tool /
pattern / time; model-facing `session_query` tool; workspace-dir auth.
**Tests:** indexing round-trip, query shapes, authorization denial,
bounded results, corrupt-file skip.

## 14b. Cross-machine resume — deepseek durable projection, not codex rollouts

**Status:** ✅ P1 done (2026-08-22). Remote transport remains Phase G.

**Shipped:** `SessionMetadata.provenance` (`originNode` / `resumedFrom` /
`checkpointAt`); `PersistedSession.checkpoint()`; `--resume` stamps
provenance; `--resume-remote` parses and errors
`"requires mesh adapter"`.
**Tests:** checkpoint/restore round-trip, provenance on resume, remote stub.

## 15. External config import — codex importers + deepseek hook bridges

**Design (`src/import/`):**

```ts
// detect.ts — detect CLAUDE.md, Cursor rules (.cursor/rules), codex config.toml
//   + AGENTS.md, deepseek preset cordis.yml (later)
// toConfig.ts — map each source to envoy ConfigLayer + AGENTS.md concat
// importers/claude.ts, importers/cursor.ts, importers/codex.ts — golden-file tested
// hook-bridge/ — JSON-RPC-over-stdio hook runner (codex/Claude hook protocol)
//   beside the existing shell/module runners (same event names)
```

`envoy import <dir>` command; hooks bridge makes existing `hooks.json` handlers
runnable as-is.
**Tests:** golden files per source, conflict resolution, hook protocol
conformance against a scripted hook process, timeout/error mapping.

## 16. Feedback loop — deepseek contracts + self-evolution input

**Status:** ✅ done (2026-08-22).

**Shipped (`src/feedback/`):** append-only `FeedbackStore`; per-message
sidecar CRUD; `feedback_record` tool; `toSelfEvolveSignals` contamination
guard (raw notes never included). Full self-evolve wiring can consume the
signals helper later without prompt injection.
**Tests:** immutability, sidecar CRUD, no-injection.

## 17. Observability — deepseek runtime-diagnostics + telemetry sink

**Status:** ✅ done (2026-08-22).

**Shipped (`src/trace/telemetry.ts`, `src/trace/invariants.ts`):**
`TelemetrySink` with turn/tool/job counters; JSONL + null sinks;
redaction + shape invariants.
**Tests:** sink contract, invariant failure on secret leak.

---

## Explicit "do not" list

- Do **not** adopt Cordis as a platform (deepseek) — the plugin system is the
  product; the compat container is whitelist-only and optional.
- Do **not** port codex's Rust crates — different language, no ABI.
- Do **not** build a cloud/app-server or codex-style rollouts — the distribution
  model is the P2P mesh, not a cloud backend.
- Do **not** put a TUI in Package 1 — the mesh's Tauri host is the UI.
- Do **not** put mesh credentials or peer state in Package 1.

## Success criteria

- Every item ships with hermetic tests and an additive public seam; module-size
  CI stays green (new families are new modules).
- L0/L1/L3 reuse is shipped by Phase F: SKILL.md compatibility (codex +
  deepseek roots readable), landlock-run behind the sandbox seam, and the
  deepseek contracts implemented natively.
- L4 (Cordis container) is gated on a real user need and never exceeds the
  3-plugin whitelist without a documented audit.
- Local scenario reaches parity: compact/memory/skills/jobs/web/terminal/ask-user/
  plan/search/feedback/observability all work with zero mesh, zero network,
  zero live LLM in tests.
- Mesh scenario keeps its moat: reputation, verifier, chain-graph, and federated
  self-evolution are untouched or strengthened; v2.2 transport is the only
  prerequisite for remote variants of jobs/terminal/memory/query.
