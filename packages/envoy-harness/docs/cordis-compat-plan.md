# Cordis-compat container — implementation plan (gap-closure L4)

> **Status:** DRAFT (2026-08-22). **C0 spike: ✅ PASSED** —
> `@envoymesh/envoy-harness-cordis` hosts `dsh-jobs-local@0.1.1-rc.2` on a
> real `@deepseek-ai/cordis@4.0.1` context; full job lifecycle works and
> behavior parity vs envoy's native `src/jobs` holds
> (`test/jobs-parity.test.ts`). Audit record:
> `packages/envoy-harness-cordis/docs/audit-jobs-local.md`.
> **C1 (container core): ✅ DONE** — whitelist + dependency-order service
> application + error isolation + status snapshots + ordered dispose
> (`createCordisContainer`; `test/container.test.ts`).
> **C3 skills: ✅ DONE** — `skill-filesystem` hosted with parity vs envoy's
> SKILL.md loader (`test/skill-filesystem.test.ts`; audit
> `audit-skill-filesystem.md`). C2's fs adapter is narrowed to hardening:
> the container uses the published `dsh-fs-local` backend; a sandbox-gated
> envoy fs adapter replaces it for production.
> **C2 fs adapter: ✅ DONE** — `EnvoyFileSystem` implements the abstract
> dsh fs contract over envoy's filesystem with sandbox enforcement on
> mutations (`FS_SANDBOX_DENIED` outside writable roots / read-only mode),
> injectable as the `fs` service override
> (`test/envoy-fs.test.ts`, 7 tests; skill-filesystem verified over it).
> Key finding: Cordis proxies services, so adapters must NOT use private
> `#` fields.
> **C3 credentials + web: ✅ DONE** — `credentials-local` (file-backed
> credential document, mode-600 enforced) and `web-search-exa` (provider
> registered on `ctx.web`) hosted; audits + tests
> (`test/c3-plugins.test.ts`). **terminal-bash: ⛔ BLOCKED on
> publication** — `dsh-terminal`/`dsh-terminal-bash`/`dsh-subprocess` exist
> on npm only at stale `0.0.1-rc.x` (pre-architecture); mixing them into the
> `0.1.1-rc.2` container would break contracts. Unblock = deepseek publishes
> current versions, or a deliberate vendoring decision (MIT, per-plugin
> documented exception).
> **C4 bridges: ✅ DONE** — `createHostedSkillsProvider` adapts hosted
> `ctx.skills` into envoy's native `SkillProvider` (envoy's `skill` tool can
> load deepseek-hosted skills); `createHostedJobsRegistry` adapts hosted
> `ctx.jobs` into envoy's `JobRegistry` (owner tracking + `disposeOwner`);
> `container.capabilities()` exposes the hosted service surface for
> EnvoyMesh/Tauri hosts. Tests: `test/bridges.test.ts`. Owner: envoy-harness
> team.
>
> **C3 terminal decision (2026-08-22):** do NOT vendor/sync deepseek's
> terminal family. Target = **feature parity with an envoy-owned
> implementation** (Path B). Feature matrix vs deepseek `dsh-terminal`:
> persistent owner-scoped sessions ✅, six model-facing tools
> (`terminal_open/send/read/signal/close/list`) ✅,
> `terminal_send(run_in_background: true)` via the jobs registry (preflight
> reservation before the job id, `job_kill` → SIGINT) ✅ (new),
> readiness/quiescence detection (`inferred_idle`/`timeout`/`session_exit`)
> ✅ (new in the pty backend), bounded UTF-8-safe results (256 KiB cap) ✅
> (new), sandbox via envoy's policy/tool layer ✅. Remaining minor gap:
> deepseek contributes a fixed "terminal guidance" section to the system
> prompt; envoy has no system-prompt plugin — tool descriptions cover the
> guidance. terminal-bash/subprocess themselves are NOT hosted (own
> implementation, no upstream sync).
>
> **System-prompt decision (2026-08-22):** do NOT host
> `dsh-system-prompt`. It is an assembler whose contributors (tool-*/
> agent-*) are stale or deliberately unhosted — hosting it would render an
> empty scaffold. Envoy got a **native assembly module**
> (`src/system-prompt/`) mirroring deepseek's `PromptSection` shape
> (`{ name, order, text }`) so future deepseek contributions **copy in**
> (MIT) or bridge cleanly. Wired: AGENTS.md discovery (-100, previously
> disconnected from the run path), plan mode (-50), terminal guidance
> (100). 10 new tests; one-shot/REPL/team all wire it.
>
> **Ecosystem reuse: tools + skills (2026-08-22):**
> - **Skills (L0):** envoy's loader reads deepseek's roots
>   (`.dsh/skills`, `~/.dsh/skills`, `~/.agents/skills`) and now ships the
>   deepseek-style **catalog projection** (`<available_skills>` block via
>   `src/skills/catalog.ts`, digest-based re-publish, bounded fragment).
> - **MCP tools (universal):** `registerMcpTools` bridges any MCP server's
>   tools into envoy's registry as `mcp__<server>__<tool>` (Codex/Claude/
>   deepseek convention) — the scalable tool-ecosystem reuse path.
> - **Team default:** `system_prompt` is now optional in team TOML; the
>   runner defaults to the assembled AGENTS.md + guidance prompt.
> - Guide: `docs/reuse-deepseek-tools-skills.md`. 12 new tests.
> Input to `gap-closure-plan.md` item 3 / the L4 section. This plan
> upgrades the earlier "optional, gated" stance to a **committed build**
> because the goal is literal reuse of the deepseek-harness plugin
> ecosystem. The gate moves from "should we?" to "which plugins, in what
> order, with what adapters?"
>
> **Why the earlier estimate was too pessimistic:** the original plan
> assumed we'd re-implement a Cordis-compatible context facade. Verified
> facts change that:
> - `@deepseek-ai/cordis@4.0.1` is **published** with types (`lib/types/index.d.ts`)
>   and exports — we use the real runtime, not a clone.
> - The dsh capability contracts (`dsh-jobs`, `dsh-skill`, `dsh-credentials`,
>   `dsh-scope`, `dsh-timeout`, `dsh-invariants`, …) are **published** at
>   `0.0.1-rc.x` with types.
> - Deepseek plugins are function / class / `{ apply }` shapes that run on a
>   Cordis `Context` (verified in `vendor/cordis/src/registry.ts` and
>   `packages/jobs/jobs-local/src/index.ts`, which exports `default
>   LocalJobRegistry`).
> - The remaining work is **envoy-side service adapters** (tools, fs,
>   subprocess/shell, session, llm, logger→trace), not a Cordis clone.

## 1. Goal

Let envoy-harness host a **curated, audited whitelist** of deepseek-harness
Cordis plugins in-process, so the deepseek ecosystem (providers, backends,
and future plugins) runs on envoy-harness without re-implementation.

**What "full" means:**
- A container package `@envoymesh/envoy-harness-cordis` that boots a real
  Cordis root context, installs envoy-native services under the dsh service
  keys, and applies whitelisted plugins.
- Host configuration (`config.toml` → `cordis.plugins = [...]`) plus
  `/cordis` REPL commands for list/status/reload.
- Parity-tested hosting for the starter whitelist; an audit checklist that
  new plugins must pass; a version-pinning gate.
- Plugins' model-facing tools surface through envoy's `ToolRegistry` (so the
  agent loop, permissions, hooks, and sandbox still govern them).

## 2. Architecture

```
envoy-harness (Package 1)
└── src/cordis/                     # thin host: loader + lifecycle + config
    └── @envoymesh/envoy-harness-cordis   # the container package (new)
        ├── runtime.ts              # boots @deepseek-ai/cordis Context
        ├── services/               # envoy-native service adapters
        │   ├── tools.ts            # dsh tools registration → envoy ToolRegistry
        │   ├── fs.ts               # dsh-fs contract → envoy fs + sandbox policy
        │   ├── shell.ts            # dsh-shell/subprocess → envoy bash tool path
        │   ├── session.ts          # dsh-session contract → envoy SessionStore
        │   ├── llm.ts              # dsh-llm contract → envoy ModelAdapter
        │   └── logger.ts           # ctx.logger → envoy trace/JSONL
        ├── plugins/                # whitelist manifests + audit records
        ├── loader.ts               # config-driven apply + dispose + isolation
        └── version-pins.ts         # exact dsh/cordis versions + CI check
```

**Runtime boot:**
1. `new Context()` from `@deepseek-ai/cordis` (the real root context).
2. Install the published dsh **peer services** we don't adapt
   (`dsh-scope`, `dsh-invariants`, `dsh-timeout`, `dsh-jobs` contract,
   `dsh-skill` contract, …) as-is where the contracts are pure/pluggable.
3. Register envoy-native adapters under the service keys the whitelisted
   plugins consume (`ctx.tools`, `ctx.fs`, `ctx.subprocess`, `ctx.session`,
   `ctx.llm`, `ctx.logger`).
4. `ctx.plugin(PluginClass, config)` for each whitelisted plugin, in
   dependency order; collect disposers.
5. Bridge model-facing tools the plugins register into envoy's
   `ToolRegistry` (translation layer — deepseek tool shape → envoy `Tool`),
   so the agent loop's hooks/permissions/sandbox still apply.

**Plugin providers vs consumers:** many whitelist plugins *provide* a
service (jobs-local provides `ctx.jobs`; skill-filesystem provides the
filesystem skill provider). The container only adapts the services they
*consume*. Each plugin's consumed-ctx-key set is recorded in its whitelist
manifest (the audit).

## 3. Version strategy (the stale-rc problem)

Verified: npm has `cordis@4.0.1`, `dsh-jobs-local@0.0.1-rc.3`,
`dsh-skill-filesystem@0.0.1-rc.3`, `dsh-credentials-local@0.0.1-rc.1`; the
deepseek repo HEAD is `0.1.1-rc.1` (not published). Decision:

- **Consume published versions, pinned exactly** (`0.0.1-rc.3`, no `^`).
  "Reuse the ecosystem" means consuming their releases, not their repo HEAD.
- `pnpm-lock.yaml` in the container package is the source of truth; CI runs
  `pnpm install --frozen-lockfile` for it and fails on drift.
- The **C0 spike** validates that the published contracts match the repo's
  architecture before we commit. If a must-have plugin only exists at repo
  HEAD, vendor that single package under `vendor/` with its MIT license
  header (documented exception, per-plugin).
- A small script `scripts/pin-cordis.mjs` checks npm for newer rc versions
  and prints a bump report (manual upgrade, no auto-bump).

## 4. Starter whitelist (in priority order)

| # | Plugin (published) | Provides | Consumes (audit) | Envoy adapter needed |
|---|---|---|---|---|
| 1 | `dsh-jobs-local` | `ctx.jobs` | agent, scope, timeout, invariants, jobs, cordis | logger → trace |
| 2 | `dsh-skill-filesystem` | skill provider | fs, home-paths, skill, invariants, cordis | **fs** (sandboxed) |
| 3 | `dsh-credentials-local` | credential provider | atomic-write, credentials, launch-environment, home-paths, invariants, cordis | atomic-write → envoy fs |
| 4 | `dsh-web-search-*` (exa/perplexity) | web provider | web, llm, invariants, cordis | llm, credentials |
| 5 | `dsh-terminal-bash` | terminal backend | subprocess, terminals, cordis | **subprocess/shell** |

Anything beyond this list requires a whitelist entry + audit record (see §6).

## 5. Phases and chunks

### C0 — Spike: prove the published stack boots + parity (2–3 days)
Goal: host `dsh-jobs-local@0.0.1-rc.3` on a real Cordis root context with a
logger adapter, and prove behavior parity against the native `src/jobs`
implementation.
- Scaffold `packages/envoy-harness-cordis` (empty package, pinned deps).
- Boot `Context`, install published peer services, apply `LocalJobRegistry`.
- Adapter: `ctx.logger` → envoy trace. Everything else must come from the
  published packages.
- Parity test: same job lifecycle (start/status/cancel/wait/completion)
  through the hosted plugin vs `src/jobs` — same outcomes, same snapshots.
- **Exit criteria:** spike green + a written audit record for jobs-local
  (every ctx key it touches, listed with evidence from its source).
- **Decision gate:** if the published jobs-local API diverges so far from
  the repo shape that the adapter is larger than the L3 port, stop and
  report (the ecosystem-reuse premise fails for that plugin; revisit
  vendoring).

### C1 — Container core (1–2 weeks)
- `runtime.ts` boot/dispose lifecycle (start, stop, ordered disposers,
  idempotent reload via `/cordis reload`).
- `loader.ts`: `cordis.plugins` config parsing (TOML list, per-plugin
  config via the existing `--plugin-config` merge), validation against the
  whitelist, dependency-order apply, error isolation (a throwing plugin
  disables itself, not the agent).
- `logger.ts` adapter + trace events (`cordis.plugin_start/stop/error`).
- REPL commands `/cordis` (list/status/reload) + `/cordis audit <name>`.
- Version-pin CI gate + `scripts/pin-cordis.mjs` bump report.
- Tests: lifecycle, config validation, isolation, reload, pin gate.

### C2 — Envoy service adapters (audit-driven; 1–2 weeks)
Implement only the adapters the whitelist plugins actually consume:
- `fs.ts` — dsh-fs contract over envoy's filesystem with the **active
  sandbox policy** (bash validators + SandboxExecutor path; a plugin's file
  reads/writes are governed like the agent's own tools).
- `shell.ts`/`subprocess.ts` — dsh-shell/subprocess over envoy's bash tool
  execution path (timeouts, output caps, abort, validators).
- `session.ts` — dsh-session reads/writes over `SessionStore`.
- `llm.ts` — dsh-llm `complete` over envoy `ModelAdapter` (per-call
  `providerHint` reuse).
- `tools.ts` — deepseek tool definition → envoy `Tool` translation, so
  plugin-registered tools appear in the agent's registry with hooks +
  permissions applied.
- Tests: each adapter gets a contract test against a scripted plugin
  fixture + a parity test where a native equivalent exists.

### C3 — Whitelist expansion (ongoing, 1 chunk per plugin)
- 2. `skill-filesystem` (SKILL.md provider → envoy `src/skills` registry).
- 3. `credentials-local` (env/.env provider → envoy `src/credentials`).
- 4. `web-search-exa` / `web-search-perplexity` → envoy `src/web`.
- 5. `terminal-bash` → envoy `src/terminal`.
- Each ships with its audit record + parity tests + `/cordis audit` entry.

### C4 — Mesh angle (later, after the transport v2.2)
- Expose hosted capabilities to EnvoyMesh via the ACP/SDK surface.
- Optional future: run the container in a child process (stronger
  isolation) bridged over JSON-RPC, reusing the ACP framing.

## 6. Audit checklist (every whitelist entry must satisfy)

1. **Consumed ctx keys enumerated** from source (not just `inject` list) —
   recorded in the plugin's manifest.
2. **No Cordis fiber usage** outside the published service contracts.
3. **No scope-layer mutation** beyond documented registry writes.
4. **No direct `ctx.model` streaming assumptions** (envoy adapters differ).
5. **No reliance on the Cordis event bus for correctness** (only logging/
   notifications); if a plugin does, the adapter must provide that event
   surface explicitly.
6. **Config via schemastery** (validated) or a plain object.
7. **Filesystem/subprocess access** goes through the envoy adapters (never
   raw `node:fs`/`child_process` in the plugin's hot path) — enforced by
   review, not runtime.
8. **Version pin** exact + lockfile frozen in CI.

Rejection is default: a plugin that fails any item is not whitelisted until
the gap is closed by an adapter or a documented exception.

## 7. Security

- The whitelist + audit + pinned versions are the security boundary (a
  plugin is code execution by definition).
- In-process by default (C0–C3) with the fs/shell adapters enforcing envoy's
  sandbox policy; child-process isolation is C4.
- Credentials redaction applies to plugin traces (reuse
  `src/credentials/redaction.ts`).
- No network access beyond what the plugin's declared provider needs, and
  only through configured providers.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Published rc versions diverge from deepseek repo HEAD | C0 spike gates the premise; per-plugin vendoring documented exception |
| Cordis semantics (fibers/scopes/dispose ordering) surprise us | Use the real Cordis runtime; parity tests; the audit's fiber rule |
| Adapter surface creep (fs/shell/session/llm/tools) | C2 is audit-driven — implement only consumed keys; each adapter has a contract test |
| Deepseek release cadence | Exact pins + `pin-cordis.mjs` bump report; upgrades are explicit PRs with parity re-runs |
| In-process plugin crash takes the agent down | Error isolation in the loader; C4 child-process option |
| Duplication with L3 ports | Explicit policy: the container hosts *provider* plugins; envoy-native implementations remain the default for core capabilities |

## 9. Effort and sequencing

- C0 spike: 2–3 days (gate).
- C1 container core: 1–2 weeks.
- C2 adapters: 1–2 weeks.
- C3 per plugin: ~2–3 days each (skills → credentials → web → terminal).
- C4 mesh exposure: later, tied to transport v2.2.

Sequence: C0 → C1 → C2 → C3 (skills first — highest reuse value) → C4.

## 10. Success criteria

- `dsh-jobs-local` hosted with behavior parity vs `src/jobs` (C0).
- Container boots from `config.toml`; `/cordis` lists status + audit; a
  crashing plugin disables itself (C1).
- `skill-filesystem` hosts SKILL.md skills from deepseek roots into envoy's
  skill registry; `credentials-local` and `web-search-*` providers work
  through the envoy seams (C2/C3).
- Full hermetic test suite green in both repos; module-size + pin CI gates
  pass; no changes to the agent loop's public surface.
- Audit records exist for every whitelisted plugin; the whitelist never
  grows without one.

## 11. Open questions to resolve in C0

- Do the published `0.0.1-rc.x` contracts match the repo's architecture for
  jobs (and later skills/credentials)? (The spike answers this.)
- Which Cordis version pins: `4.0.1` exact, or the repo's vendored version?
- Do we need `dsh-agent`/`dsh-session` at runtime for the starter whitelist,
  or are they type-only?
- In-process vs child-process: confirm in-process for v1; document the C4
  upgrade path.
- Where the container lives: this monorepo (`packages/envoy-harness-cordis`)
  vs EnvoyMesh — recommend here (Package-1-adjacent, hermetic tests).
