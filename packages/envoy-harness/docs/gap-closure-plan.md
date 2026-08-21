# Gap-closure plan — envoy-harness vs codex / deepseek-harness

> **Status:** DRAFT (2026-08-21). Input to `design.md` / `implementation-plan.md` —
> each item below becomes a design chunk with its own acceptance criteria and
> tests before it ships. This document answers the question "what do we need to
> build to reach local parity with codex / deepseek-harness **and** keep the
> mesh-native moat?"
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

| # | Capability | Recommendation | Effort | Phase |
|---|---|---|---|---|
| 1 | Compaction variants | Follow codex (algorithm family) | M (2 chunks) | A |
| 2 | Memories | Hybrid: codex format + deepseek retrieval discipline | M (2–3 chunks) | A |
| 3 | Plugins at runtime | **Invent** a lightweight capability-module seam; adopt deepseek contract shapes | L (3–4 chunks) | B |
| 4 | OS sandbox kernels | Reuse deepseek's published landlock-run npm family (Linux) + seatbelt (macOS) | M (2 chunks) | F |
| 5 | Ask-user / elicitation | Follow deepseek interaction/user-questions | S–M (1–2 chunks) | A |
| 6 | Plan | Follow deepseek plan-mode (logged collaboration state) | S (1 chunk) | A |
| 7 | Background jobs | Follow deepseek jobs family contract | M (2 chunks) | C |
| 8 | Web search / fetch | Follow deepseek web family (provider seam) | M (2 chunks) | C |
| 9 | Persistent PTY / terminal | Follow deepseek terminal family | M (2 chunks) | C |
| 10 | Automation protocol | Follow deepseek ACP server | M (2 chunks) | E |
| 11 | SDK / embedding | Follow deepseek JSON-RPC SDK + TS client; Python later | M (2 chunks) + L (py) | E |
| 12 | TUI / rich UI | Follow codex TUI *design*, but build in EnvoyMesh's Tauri host, not the core | REPL S; Tauri L | G |
| 13 | Secrets / credentials / keyring | Hybrid: deepseek-style provider seam in P1; mesh credentials in the adapter | M (2 chunks) | C/G |
| 14a | Session query / history search | Follow deepseek session-query | M (2 chunks) | D |
| 14b | Cross-machine resume | Follow deepseek durable-session projection (simpler than codex rollouts) | M (2 chunks) | D/G |
| 15 | External config import | Both: codex-style importers + deepseek-style hook bridges | S–M (1–2 chunks) | B |
| 16 | Feedback loop | Follow deepseek feedback family, wired into verifier/self-evolution | M (2 chunks) | D |
| 17 | Observability | Follow deepseek runtime-diagnostics + telemetry sink seam | M (2 chunks) | D |

## Phases

- **Phase A — Loop & context** (1–2 weeks): 1, 2, 5, 6. Unblocks the agent's
  day-to-day power.
- **Phase B — Runtime extensibility** (1–2 weeks): 3, 15. Foundation for C/D/E.
- **Phase C — Environment & long-running** (2–3 weeks): 7, 8, 9, 13 (P1 part).
  Depends on B.
- **Phase D — Data & observability** (2 weeks): 14a, 14b (P1 part), 16, 17.
  Parallel with C.
- **Phase E — Automation & embedding** (1–2 weeks): 10, 11. Depends on A + B.
- **Phase F — OS sandbox** (1 week): 4. Independent; needs a Linux CI job.
- **Phase G — Mesh-native integration** (continuous): 13 (adapter), 14b (remote
  transport), distributed skills/memory/jobs, 12 (Tauri UI). Depends on
  EnvoyMesh v2.2 transport.

---

## 1. Compaction variants — follow codex

**What codex has:** a compaction family — core `compact.rs`, token-budget
compaction (`compact_token_budget.rs`), remote-history compaction
(`compact_remote*.rs`), model-fallback (`compact_model_fallback.rs`), and thread
rollout truncation (`thread_rollout_truncation.rs`). envoy-harness today has
drop-oldest + LLM-summarize (`src/agent/compact.ts`).

**What to port (algorithms, not code):**
- **Token-budget-aware compaction:** estimate tokens per message (we already
  have `src/tokenize.ts`), drop/summarize the oldest prefix until the transcript
  fits a budget, keep the newest turns intact.
- **Remote-history compaction:** maintain a rolling summary of the dropped
  prefix so repeated compactions degrade gracefully (compact of a compact).
- **Model-fallback:** if the summarizer fails → drop-oldest (the REPL already
  does this; promote it into the strategy).

**Seam:** extend `compactMessages`/`compactMessagesWithSummary` with a strategy
union (`"drop-oldest" | "summarize" | "budget" | "remote-history"`) and wire
`/compact` flags. `ContextualUserFragment` keeps injected summaries bounded.

**Mesh angle:** budget-aware compaction matters most in chain work — a worker
that compacts badly loses context; surface compaction quality in the scoreboard
(penalize repeated poor compaction) once fragments carry size metadata.

**Tests:** budget math, rolling-summary idempotency, fallback on summarizer
failure, no-op edges (system-message case already covered).

## 2. Memories — analyze first, then hybrid

**Codex model:** a startup consolidation pipeline (`memories/write`: Phase 1 +
Phase 2 prompts, `raw_memories.md`, extension resources, guard limits) plus a
read path (`memories/read`) that injects **cited, bounded memory fragments** and
parses citations. Memory is markdown files under a known root — portable and
user-visible.

**Deepseek model:** no consolidation; `session-query` gives **authorized
retrieval over durable session logs** (trusted reads, relationship queries,
search), independent of compaction. Memory = searchable history, not a curated
file.

**Recommendation — hybrid, biased to codex's format:**
1. **User memory files** (markdown, codex-compatible root/format) injected as
   bounded fragments with citations. Reuses `src/context/fragment.ts`.
2. **Session-derived memory:** a lightweight consolidation on session end (one
   summarizer call) that appends decisions/file paths to the user memory file.
   No Phase-1/Phase-2 pipeline in v1 — keep it one-pass.
3. **Retrieval seam borrowed from deepseek:** `SessionQueryService`
   (workspace-authorized reads over live + persisted sessions) — see 14a.

**Mesh angle:** later, memory files can be federated (a worker's consolidation
is queryable by the verifier) — this is a differentiator, not a parity item.

**Tests:** citation rendering, bounded injection, consolidation prompt shape,
no-duplication on repeated session ends.

## 3. Plugins at runtime — invent, don't copy Cordis

**Why not Cordis (deepseek):** its plugin model (`apply(ctx, config)`, `inject`,
scope layers, disposers) is coupled to the Cordis runtime; adopting it means
adopting the platform. **Why not codex plugins:** Rust-native, compiled in.

**Recommendation — a small envoy capability-module seam:**
```ts
interface CapabilityContext {
  config: ConfigLayer;
  hooks: HookRegistry;
  tools: ToolRegistry;          // register model-facing tools
  session: SessionStore;        // persisted sessions
  trace: Tracer;
  cost: CostTracker;
  submitter: MeshSubmitter;     // optional, for mesh-aware capabilities
  credentials: CredentialsProvider; // item 13
}
interface CapabilityModule {
  name: string;
  version: string;
  activate(ctx: CapabilityContext): Promise<Disposable>;
}
```
Local loader scans `~/.config/envoy-harness/capabilities/` and project
`.envoy/capabilities/`. **Adopt deepseek's contract shapes** (`ctx.jobs`,
`ctx.skills`, `ctx.terminals`, `ctx.web`, `ctx.credentials`) so ports from
deepseek are mechanical — implement the same interface names over envoy's seams.

**Model-facing extensibility is separate:** the SKILL.md loader (standard,
compatible with codex + deepseek skill catalogs) — do this first if the plugin
seam is too much; skills cover 80% of the "extend the agent" use case.

**Tests:** lifecycle (activate/dispose/idempotent reload), hermetic fake ctx,
module-size discipline, failure isolation (a crashing capability disables
itself, not the agent).

## 4. OS sandbox kernels — reuse deepseek's landlock npm family

**Investigation result:** codex implements seatbelt (macOS), bwrap/landlock
(Linux), Windows sandbox in Rust — not reusable from TS. Deepseek publishes
**`landlock-run` as a three-package npm family (MIT, `native/landlock-run`)**:
a self-restrict-then-exec launcher with platform packages as optional deps —
**directly installable from TS**.

**Recommendation:**
- **Linux (primary — EnvoyMesh nodes):** depend on deepseek's landlock-run
  package behind the existing `SandboxExecutor` seam (`src/sandbox/types.ts`).
  This is the rare case where depending on a published artifact beats porting:
  MIT, maintained, platform-packaged.
- **macOS (local dev):** `SeatbeltSandboxExecutor` spawning `sandbox-exec` with
  a generated profile — no new dependency.
- **Windows:** keep the 6 bash validators; defer job-object sandboxing.
- **Optional later:** E2B remote runtime family (deepseek `packages/e2b`) as a
  *remote* sandbox provider — fits the mesh story (sandbox on another node).

**Tests:** executor contract parity tests with a fake kernel; landlock smoke
test in a Linux CI job (new); seatbelt integration marked live/opt-in on macOS.

## 5. Ask-user / elicitation — follow deepseek

**What deepseek has:** `ctx.userQuestions` — a provider-neutral service
(`registerProvider`, `ask(request): Promise<Answer>`), single active provider,
multiline support, and an `authorization` family for credential-gated flows.

**What envoy-harness has:** approval-asking (`AskForApproval`/`AskHandler`) but
no open-ended user-question seam.

**Recommendation:** add `UserQuestionService` with a REPL stdin provider, a
Tauri/mesh remote provider (adapter), and a model-facing `ask_user` tool.
**Extend** the approval flow to delegate to the same provider (one interaction
surface), don't build a parallel one.

**Tests:** fake provider answers, timeout, single-provider enforcement,
multiline round-trip, approval delegation.

## 6. Plan — follow deepseek plan-mode

**What deepseek has:** plan mode as **logged, per-agent collaboration state**
(not a generic mode registry): plan state, guidance, commands, and a review
flow, owned by `ctx.planMode`.

**What envoy-harness has:** `--plan` read-only flag in one-shot mode only.

**Recommendation:** plan state on the session (flag + plan text + review
status); `/plan` command; plan injected as a bounded fragment (context budget);
plan review hands off to the existing verifier (`/review`). **Mesh angle:** a
worker's plan rides along chain subtasks and is visible to the verifier — plan
is collaboration state, which is exactly the mesh's job.

**Tests:** state transitions, guidance injection, review handoff, session
persistence of plan state.

## 7. Background jobs — follow deepseek jobs family

**What deepseek has:** `ctx.jobs` — job registry + lifecycle contract,
owner-fenced ids, snapshots, observe/cancel/wait/completion notices, a
process-local provider, and model-facing `tool-jobs`.

**Recommendation:** port the **contract** into `src/jobs/`: `JobRegistry`,
`JobHandle` (status, snapshot, cancel, wait), a process-local provider for
long-running bash/edit commands, and `job_*` tools. Owner-fencing prevents one
agent killing another's job — important once sub-agents run concurrently
(`src/subagent/fan-out.ts`).

**Mesh angle:** later, a remote job handle via `MeshSubmitter` — long-running
work on another node with observe/cancel.

**Tests:** registry lifecycle, owner-fencing, completion notices, cancellation,
fake long-running command.

## 8. Web search / fetch — follow deepseek web family

**What deepseek has:** `ctx.web` — provider-neutral registration/selection,
providers (exa, perplexity, deepseek), and model-facing search/fetch tools.

**Recommendation:** `WebProvider` seam in `src/web/` with a fetch provider
(built-in, no key) + search providers as optional capabilities (keys come from
item 13's credentials seam). Keep MCP as the alternate path for web tools —
both coexist. API keys are never in config files shipped to the mesh.

**Tests:** provider selection, error mapping, fetch size caps (bounded result
via fragments), fake providers.

## 9. Persistent PTY / terminal — follow deepseek terminal family

**What deepseek has:** `ctx.terminals` — persistent, owner-scoped PTY sessions
(backend registry, branded ids, exact-Agent ownership, session ops), a bash
backend, and six model-facing tools.

**Recommendation:** `src/terminal/` with a `TerminalBackend` seam, `node-pty`
as the first backend (justified runtime dep — only this module), and
`terminal_*` tools. Hermetic tests use a fake backend. Terminal complements
one-shot bash (stateful workflows, interactive stdin), it doesn't replace it.

**Mesh angle:** remote terminal on another node via submitter (later).

## 10. Automation protocol — follow deepseek ACP server

**What deepseek has:** `packages/acp` — an automation-only Agent Client
Protocol server over JSON-RPC stdio: `initialize`, `session/new`,
`session/prompt`, `session/cancel`, `session/update` (committed messages),
`session/request_permission` (one-shot allow/reject). Clients: `subagent-acp`.

**Recommendation:** implement ACP in Package 1 reusing the Agent + session
seams (no editor/fs capabilities advertised). This gives EnvoyMesh a
programmatic way to drive a harness agent and is the transport backbone for
item 11.

**Tests:** protocol conformance with a scripted stdio pair (same pattern as
`test/mcp-stdio.test.ts`), cancellation, permission one-shots, committed-message
delivery.

## 11. SDK / embedding — follow deepseek JSON-RPC SDK, TS first

**What deepseek has:** a JSON-RPC SDK (`packages/sdk`: protocol, server, TS
client) and a Python SDK (`python/`).

**Recommendation:** ship **one JSON-RPC protocol** used by both ACP (item 10)
and the SDK — same transport, two surfaces. Deliver `@envoymesh/envoy-harness-client`
(TS) in this repo; the Python SDK is a separate published package, only when
there is a consumer (EnvoyMesh nodes are TS; the mesh doesn't need Python).

**Tests:** client/server round-trip over stdio, request/response framing, error
mapping, cancel.

## 12. TUI / rich UI — follow codex TUI *design*, build in the mesh host

**Investigation result:** codex's TUI (bottom-pane composer, transcript view,
approval surface, slash-command palette) is a product layer, not a harness
capability. EnvoyMesh already has a **Tauri app** (`EnvoyMesh/apps/tauri`) that
consumes the vendored harness — that is the envoy-native UI host.

**Recommendation:** keep Package 1 UI-free (matches the design's "not a UI
application" stance). Build the rich UI in the Tauri host over the ACP/SDK
surface. In-repo stopgap: REPL upgrades (multiline input, diff highlighting,
scoreboard tables).

## 13. Secrets / credentials / keyring — hybrid, mesh-aware

**Investigation:** deepseek separates reference resolution from provider and
from "obtain a credential by asking" (`credentials`, `credentials-local`,
`authorization`). Codex uses OS keyring + login + cloud auth. For EnvoyMesh,
credentials are **per-peer and signed** (Ed25519 identity already exists).

**Recommendation:**
- **Package 1:** `CredentialsProvider` seam with env + local-file providers
  (deepseek-style) and the `authorization` ask flow (via item 5's user-questions
  seam). No OS keyring in v1.
- **Package 3 (adapter):** mesh credentials — per-peer API keys, node identity,
  signed envelope credentials. **Never** mesh secrets in Package 1.

**Tests:** provider selection, reference resolution, ask-flow, redaction in
traces (a credential must never appear in session logs).

## 14a. Session query / history search — follow deepseek session-query

**What deepseek has:** `session-query` — authorized retrieval over live +
durable logs (trusted reads, relationship queries, search), SQLite FTS
provider, model-facing `tool-session-query`, workspace-authorized.

**Recommendation:** index persisted JSONL sessions (`src/session/persisted-session.ts`)
into a searchable store; `session_query` tool + `/session search`; workspace
authorization (only the cwd's sessions); results bounded via fragments.

**Mesh angle:** federated query across nodes later — a chain verifier can pull
relevant prior verdicts/sessions before judging.

**Tests:** indexing, query shapes, authorization denial, bounded results.

## 14b. Cross-machine resume — follow deepseek durable projection (not codex rollouts)

**Investigation:** codex rollouts = full session-file persistence + cloud
resume (single-operator infrastructure). Deepseek = durable session projection
(checkpoint policy, projection seam, telemetry) — simpler and self-hosted.

**Recommendation:** session checkpoint/snapshot policy on top of the existing
JSONL durability; `--resume <id>` (exists) + `--resume-remote <node>/<session>`
once the v2.2 remote-submitter transport lands; provenance field so a resumed
session records its origin node. **Do not** build a cloud layer.

## 15. External config import — both, in the right places

**Investigation:** codex `external-agent-migration` imports from Claude
Code/Cursor (detect + config mapping). Deepseek `hooks` bridges run existing
Claude Code / Codex `hooks.json` handlers faithfully; deepseek `preset`/
`bundle` compose per-session agent configs.

**Recommendation:**
- **Importers (codex-style):** `src/import/` — detect `CLAUDE.md`, Cursor rules,
  codex `config.toml`/`AGENTS.md`, and produce envoy config + AGENTS.md. Cheap
  and high value for the standalone scenario.
- **Hook bridges (deepseek-style):** add a JSON-RPC-over-stdio hook runner
  (codex/Claude hook protocol) beside the existing shell/module runners — same
  event names already (item: hook protocol). This makes existing `hooks.json`
  handlers runnable as-is.

**Tests:** importer golden files for each source; bridge conformance against a
scripted hook process.

## 16. Feedback loop — follow deepseek, full features, wired to self-evolution

**What deepseek has:** two deliberately separate contracts — an **immutable
remark** in the session log (`feedback/record`, never enters model context) and
**editable per-message rating/note sidecar** (`message-feedback`), plus
human-facing `/feedback`.

**Recommendation:**
1. `feedback/record` event → session log (never injected raw).
2. Per-message rating/note sidecar + `/feedback` and `/review` integration.
3. **The envoy-specific upgrade:** feedback is an **input to self-evolution** —
   verdicts + human feedback drive the 5-step ruleset protocol (the scoreboard
   already exists; feedback becomes a scored signal). Model-context purity is
   preserved: feedback is only injected as a bounded fragment when the user
   asks.

**Tests:** record immutability, sidecar CRUD, no-injection guarantee, feedback →
self-evolve path with the contamination guard intact.

## 17. Observability — follow deepseek runtime-diagnostics + telemetry

**What deepseek has:** runtime-diagnostics (invariants, contract assertions),
session telemetry (otel provider), versioned event shapes. **What codex has:**
otel + analytics + rollout-trace. **What envoy has:** JSONL/verbose/null
tracers + cost tracking.

**Recommendation:** a `TelemetrySink` seam (console/JSONL/otel providers),
versioned event schema (reuse the trace event types), counters + spans
(turn, tool, compaction, memory, job), and an invariants module for dev-time
contract checks. EnvoyMesh node monitoring reads the JSONL sink.

**Tests:** event-shape assertions, sink provider contract, redaction
(credentials never traced — ties to 13).

---

## Explicit "do not" list

- Do **not** adopt Cordis (deepseek) — the plugin platform is the product.
- Do **not** port codex's Rust crates — different language, no ABI.
- Do **not** build a cloud/app-server or codex-style rollouts — the distribution
  model is the P2P mesh, not a cloud backend.
- Do **not** put a TUI in Package 1 — the mesh's Tauri host is the UI.
- Do **not** put mesh credentials or peer state in Package 1.

## Success criteria

- Every item ships with hermetic tests and an additive public seam; module-size
  CI stays green (new families are new modules).
- Local scenario reaches parity: compact/memory/skills/jobs/web/terminal/ask-user/
  plan/search/feedback/observability all work with zero mesh, zero network,
  zero live LLM in tests.
- Mesh scenario keeps its moat: reputation, verifier, chain-graph, and federated
  self-evolution are untouched or strengthened; v2.2 transport is the only
  prerequisite for remote variants of jobs/terminal/memory/query.
