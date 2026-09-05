# Round 4 — Single-instance parity + deepen distribution

> **Status:** PLANNED (2026-09-05, revised same day).
> **Design:** [`distributed-collaboration.md`](./distributed-collaboration.md) §1 + §11.
> **Master index:** [`implementation-plan.md`](./implementation-plan.md) §Distributed.
>
> **Two equal product goals:**
>
> 1. **Single-instance parity (most users)** — one `envoy-harness` process
>    should feel as capable as Codex or deepseek-harness for everyday
>    coding: sub-agents, modes, async ask, session durability, skills,
>    hooks, presets. **Not everyone runs multi-nodes.**
> 2. **Multi-node depth (differentiator)** — the *same* seams also reach
>    peers / EnvoyMesh. Multi-node is the major strength; it must not be
>    the only story.

**Per-chunk discipline:** each chunk = note here (or
`implementation-plan-chunk-r4-*.md`) + code + tests + self-review commit.

**Sources (2026-09-05):** Codex (Guardian V2, multi-agent v2, async ask,
exec-server) and deepseek-harness `0.1.3-alpha.1` (session v2, write
leases, agent teams, workflow). Port *patterns*, not runtimes.

**Skip (explicit non-goals):** Code mode/V8, voice WebRTC, E2B, full
Typert codegen, Guardian ML, Cordis rewrite, EnvoyGo attachments.

---

## Coverage checklist (ROI → chunk)

### Harness refine (Codex + dsh) — single-instance first

| ROI item | Chunk | Status in plan |
|---|---|---|
| Async / non-blocking user questions | **R4.1** | ✅ |
| Retained context across compaction | **R4.2** | ✅ |
| Collaboration modes as real state (Plan / Default / Review) | **R4.6** | ✅ (own chunk; was underweighted) |
| Session format hardening (v2 migrations + write lease) | **R4.3** | ✅ (lease + format path expanded) |
| Session projections / turn outline | **R4.4** | ✅ |
| Hook refresh + merge precedence (deny > ask > allow) | **R4.5a** | ✅ (split from presets) |
| Permission presets (sandbox + approval) | **R4.5b** | ✅ |
| Skill fuzzy ranker | **R4.6b** | ✅ (own chunk) |
| Local continuable sub-agents (inbox / interrupt / settle) | **R4.9a** | ✅ (local half; required for single-instance) |
| Local parallel team DAG (`dependsOn`) | **R4.8** | ✅ (works with all-`local` teams) |
| Workflow-style fan-out API (`parallel` / `pipeline`) | **R4.17** | ✅ (**was missing** — added) |

### Distributed power (differentiator)

| ROI item | Chunk | Status in plan |
|---|---|---|
| Live `team/jobs` on standalone peer path | **R4.7** | ✅ P0 |
| Parallel DAG stages in Team runner | **R4.8** | ✅ P0 |
| Continuable **peer** tasks | **R4.9b** | ✅ P0 |
| Mesh-remote jobs + terminals | **R4.12**, **R4.13** | ✅ P1 |
| Verify budget / rate limits | **R4.10** | ✅ P1 |
| Heterogeneous subagent backends | **R4.15**, **R4.16** | ✅ P1 |
| Workflow fan-out over peers | **R4.17** | ✅ P1 (same API, peer submitters) |
| Federated scoreboard pull | **R4.11** | ✅ P2 |
| Dynamic discovery beyond static `--peers` | **R4.18** | ✅ P2 (**was missing** — added) |
| Exec-world: think local / tools on worker | **R4.14b** | ✅ after remote jobs/PTY |

---

## Phase map

| Phase | Theme | Chunks | Effort | Who it serves |
|---|---|---|---|---|
| **D-Refine** | Single-instance Codex/dsh parity | R4.1–R4.6b, R4.8, R4.9a, R4.17 | ~3 weeks | **Default: one machine** |
| **D-Ops** | Multi-node operational depth | R4.7, R4.9b, R4.10–R4.11, R4.18 | ~2–3 weeks | Peer clusters |
| **D-Mesh** | EnvoyMesh depth | R4.12–R4.14b | ~1–2 weeks | Mesh hosts |
| **D-Interop** | Heterogeneous workers | R4.15–R4.16 | ~1–2 weeks | Optional |

**Recommended order (revised):** lead with **D-Refine** so a lone instance
is excellent; weave **R4.7 / R4.9b** early if demonstrating multi-node.
Do not ship distribution polish while single-instance still feels behind
Codex/dsh on ask, modes, session, and local sub-agents.

```
D-Refine (parity)  ──parallel──►  D-Ops P0 (teamJobs, peer continuable)
        │                                    │
        ▼                                    ▼
   R4.17 workflow                    D-Mesh / D-Interop
```

---

## D-Refine — single-instance power (Codex/dsh parity)

> Everything here must work with **zero peers configured**. Multi-node
> only reuses the same APIs.

### R4.1 — Async / non-blocking user questions  **(P0 for parity)**

| | |
|---|---|
| **Why** | Codex `request_user_input_async` — long turns must not block queue/composer. |
| **Where** | `src/interaction/` + ACP question notify; TUI + EHUI docks |
| **Deliver** | Structured ask parks on the turn; user can enqueue follow-ups; answer resumes tool; cancel works |
| **Accept** | Busy turn + pending question: follow-up queues; answer unblocks; hermetic fake provider |

### R4.2 — Retained context across compaction  **(P0 for parity)**

| | |
|---|---|
| **Why** | Codex retained/Guardian checkpoint (simplified) — user answers and verified facts survive compact. |
| **Where** | `src/agent/compact.ts`, `src/context/`, session store |
| **Deliver** | Explicit retained fragment list; size-capped; re-injected after compact |
| **Accept** | Compact preserves retained items; unit tests without LLM |

### R4.3 — Session format hardening (v2 path + write lease)  **(P0 for parity)**

| | |
|---|---|
| **Why** | dsh session v2 + flock — durable log evolution + single-writer when ACP host / EnvoyGo / second process touch the same JSONL. |
| **Where** | `src/session/` |
| **Deliver** | (a) Write-ownership lease (posix flock / Windows LockFileEx); (b) documented generation/header for forward-compatible migrations (adjacent successor pattern, no silent rewrite) |
| **Accept** | Contended open fails clearly; fixture migration vN→vN+1 hermetic |

### R4.4 — Session projections / turn outline  **(P1)**

| | |
|---|---|
| **Why** | dsh projections — turn rail / `/trace` without full replay (also feeds single-instance TUI). |
| **Where** | `src/session/` + TUI/EHUI |
| **Deliver** | Incremental projection registry (turn boundaries, tool counts); optional cache |
| **Accept** | Outline matches full replay on fixture log |

### R4.5a — Hook refresh + merge precedence  **(P1)**

| | |
|---|---|
| **Why** | Codex refresh after plugin updates; dsh `deny > ask > allow`. |
| **Where** | `src/hooks/` |
| **Deliver** | Refresh hooks when plugins change; document and test merge precedence |
| **Accept** | Conflicting hooks resolve deny > ask > allow; refresh does not drop in-flight turn |

### R4.5b — Permission presets  **(P1)**

| | |
|---|---|
| **Why** | dsh presets — one control = sandbox mode + approval (EnvoyGo “keep it simple”). |
| **Where** | `src/permissions/`, config schema, EnvoyGo/Social policy menu |
| **Deliver** | Named presets (e.g. safe / ask-all / approve-all) mapping sandbox + auto-run policy |
| **Accept** | Preset round-trip in config; UI can set one value |

### R4.6 — Collaboration modes as real state  **(P0 for parity)**

| | |
|---|---|
| **Why** | Codex Plan / Default / Review — mode + tool policy + prompts, not only plan tools. |
| **Where** | `src/plan/`, system-prompt, tool allowlists, TUI/EHUI mode switch |
| **Deliver** | `ModeKind`; Plan blocks mutating tools until exit; Review = read/verify-heavy; Default = full |
| **Accept** | Mode switch changes available tools + injected prompt; single-instance only |

### R4.6b — Skill fuzzy ranker  **(P2)**

| | |
|---|---|
| **Why** | dsh recent fuzzy skill search — cheap `/` UX win. |
| **Where** | `src/skills/`, TUI/EHUI slash suggest |
| **Deliver** | Ranked skill suggest (prefix > fuzzy > catalog order) |
| **Accept** | Prefix matches rank first; hermetic ranker tests |

### R4.8 — Parallel DAG in Team runner  **(P0)** *(also D-Ops)*

| | |
|---|---|
| **Why** | Sequential `dependsOn` is weak for **local** multi-agent teams too. |
| **Where** | `src/team/runner.ts` |
| **Deliver** | Ready-set parallelism; optional retry; works with all-`local` hosts |
| **Accept** | Diamond DAG concurrent with fakes; no peers required |

### R4.9a — Continuable **local** sub-agents  **(P0 for parity)**

| | |
|---|---|
| **Why** | dsh continuable subagents — single-instance must match (inbox, interrupt, settle). |
| **Where** | `src/subagent/` |
| **Deliver** | Continuable handle over `LocalMeshSubmitter`: `send`, `interrupt`, `waitSettle`; settlement notice to parent |
| **Accept** | Local-only round-trip; no peer package required |

### R4.17 — Workflow-style fan-out API  **(P1)** *(was missing)*

| | |
|---|---|
| **Why** | dsh workflow `parallel()` / `pipeline()` — make orchestration explicit beyond opaque capability fan-out. |
| **Where** | `src/subagent/fan-out.ts` + host/model-facing API (tool or workflow module) |
| **Deliver** | Explicit `parallel(tasks)` / `pipeline(steps)` (or equivalent tools) over `MeshSubmitter`; local submitters by default; peer ids optional |
| **Accept** | Local parallel + pipeline hermetic tests; same API accepts `peer://` when cluster configured |

---

## D-Ops — multi-node operational depth

### R4.7 — Live `team/jobs` on standalone peer path  **(P0)**

| | |
|---|---|
| **Why** | ACP `team/jobs` empty outside EnvoyMesh — TUI/EHUI look dead on Scenario B. |
| **Where** | `envoy-harness-peer` UI backend + team runner events |
| **Deliver** | Registry of running/finished team + peer submits; same shape as mesh U4 |
| **Accept** | `--acp --peers` + TUI `/team` shows jobs without EnvoyMesh |

### R4.9b — Continuable **peer** tasks  **(P0)**

| | |
|---|---|
| **Why** | `peer/submit` must not stay fire-and-forget. |
| **Where** | peer server (`peer/interrupt`, `peer/status` or extended submit) |
| **Deliver** | Same continuable handle as R4.9a over `PeerMeshSubmitter` |
| **Accept** | Peer interrupt aborts in-flight execute; correlationId idempotent |

### R4.10 — Verify session budget  **(P1)**

| | |
|---|---|
| **Why** | Cross-model verify is expensive (`distributed-collaboration.md` §10b). |
| **Where** | verifier + `verifyAfterExecute` + D5 path |
| **Deliver** | `maxVerificationsPerSession` / skip when budget low; telemetry |
| **Accept** | N+1st verify skipped with explicit reason |

### R4.11 — Federated scoreboard pull (v1)  **(P2)**

| | |
|---|---|
| **Why** | Replace `LocalPeerSource` stub — reputation needs exchange. |
| **Where** | `src/scoreboard/federated.ts` + peer package |
| **Deliver** | Pull `VerdictEntry`; merge idempotently |
| **Accept** | Peer A records → peer B pulls |

### R4.18 — Dynamic discovery beyond static `--peers`  **(P2)** *(was missing)*

| | |
|---|---|
| **Why** | Static config + runtime connect exist; mDNS / mesh-backed discovery still thin. |
| **Where** | peer package + ACP `discovery/subscribe` |
| **Deliver** | Pluggable discovery source (static | mDNS | mesh feed); events already on discovery stream |
| **Accept** | Fake discovery source publishes peer; cluster rail updates hermetically |

---

## D-Mesh — EnvoyMesh depth

### R4.12 — Mesh-remote JobTransport  **(P1)**

Fill `jobs/remote.ts` when EnvoyMesh protocol exists. Hermetic fake first.

### R4.13 — Mesh-remote TerminalTransport  **(P1)**

Fill `terminal/remote.ts` — tools follow execution node.

### R4.14 — Unify chain job board ↔ peer `team/jobs`  **(P1)**

One ACP schema for Scenario A and B.

### R4.14b — Exec-world on peer (optional)

Coordinator **thinks** locally; FS/shell providers target worker peer
(Codex exec-server *idea*, MAP transport). After R4.12–13.

---

## D-Interop — heterogeneous workers (optional)

### R4.15 — Subagent provider registry  **(P1)**

Named providers: `local` | `peer` | future — one `MeshSubmitter` / `task` surface.

### R4.16 — ACP / Codex / Claude as workers  **(P3)**

*Their* agents, *our* distribution — after registry lands.

---

## Non-goals (Round 4)

- Codex Guardian ML / Windows MXC / voice WebRTC / Code mode V8
- Full Cordis rewrite / E2B / Typert codegen
- DHT or replacing EnvoyMesh libp2p
- EnvoyGo attachment parity (keep mobile simple)

---

## Test strategy

- **Single-instance CI path:** all D-Refine chunks must pass with peers
  disabled / no peer package import in Package 1 tests.
- Hermetic fakes for continuable, workflow, modes, lease, projections.
- Multi-node: in-process peer pairs; no live LLM/mesh in Package 1 CI.

---

## Tracking table

| Chunk | Phase | Priority | Serves | Status |
|---|---|---|---|---|
| R4.1 Async ask | D-Refine | **P0** | single | ✅ done (2026-09-05; `implementation-plan-chunk-r4-1.md`) |
| R4.2 Retained context | D-Refine | **P0** | single | **done** |
| R4.3 Session format + lease | D-Refine | **P0** | single | **done** |
| R4.4 Projections / turn outline | D-Refine | P1 | single | **done** |
| R4.5a Hook refresh + merge | D-Refine | P1 | single | **done** |
| R4.5b Permission presets | D-Refine | P1 | single | **done** |
| R4.6 Collaboration modes | D-Refine | **P0** | single | **done** |
| R4.6b Skill fuzzy ranker | D-Refine | P2 | single | **done** |
| R4.8 Parallel team DAG | D-Refine + D-Ops | **P0** | both | **done** |
| R4.9a Continuable local | D-Refine | **P0** | single | **done** |
| R4.17 Workflow fan-out API | D-Refine + D-Ops | P1 | both | **done** |
| R4.7 `team/jobs` peer path | D-Ops | **P0** | multi | **done** |
| R4.9b Continuable peer | D-Ops | **P0** | multi | **done** |
| R4.10 Verify budget | D-Ops | P1 | multi | planned |
| R4.11 Scoreboard pull | D-Ops | P2 | multi | planned |
| R4.18 Dynamic discovery | D-Ops | P2 | multi | planned |
| R4.12 Remote jobs | D-Mesh | P1 | multi | planned |
| R4.13 Remote terminals | D-Mesh | P1 | multi | planned |
| R4.14 Unify job boards | D-Mesh | P1 | multi | planned |
| R4.14b Exec-world on peer | D-Mesh | P2 | multi | planned |
| R4.15 Provider registry | D-Interop | P1 | both | planned |
| R4.16 External agent workers | D-Interop | P3 | multi | planned |

---

## Suggested first commit slices

**Slice A — single-instance parity (ship first):**

1. **R4.1** async ask
2. **R4.6** collaboration modes
3. **R4.9a** continuable local sub-agents
4. **R4.3** session lease (+ format header)
5. **R4.2** retained context

**Slice B — multi-node ops (parallel once Slice A is moving):**

1. **R4.7** peer `teamJobs`
2. **R4.8** parallel DAG
3. **R4.9b** continuable peer

Then R4.5a/b, R4.4, R4.17, R4.10, R4.18, D-Mesh, D-Interop.
