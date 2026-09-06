# Implementation plan — U6 product shell + Windows sandbox + IDE bridge

> **Status:** U6a.1–U6a.5 **done**. F2 lifecycle **done** (Round 6; FS
> isolation / Job-object FFI **skipped** by product decision).
> **U6b** — Round 7 **done** ([`implementation-plan-round-7.md`](./implementation-plan-round-7.md)).

Targets the gaps vs Codex / Claude Code the team flagged:

| Gap | Codex / Claude | envoy target |
|-----|----------------|--------------|
| Product shell | Mature integrated CLI/TUI | Dedicated EHUI with tabbed panels + mesh rail |
| IDE | Claude IDE-native; Codex polished terminal | EnvoyGo EHUI panel + Pi surface; TUI for terminal |
| Windows sandbox | Job objects + `windows-sandbox-rs` FS isolation | Phased: job lifecycle → FS sidecar |
| Visual richness | Native/Rust UI | ANSI theme layer (no framework creep) |

## U6a — TUI product shell (this repo) ✅ partial → Round 5

**Shipped:**

- View tab strip: `Chat  Plan  Memory  Diff  Mesh` with active `[tab]` + accent
- Status bar shows `view <name>` when not in chat
- Plan / Memory / Diff panels: section headers, dim hints, colored git diff
- `theme.ts` — small SGR helpers; hermetic tests strip ANSI
- Esc returns to chat; slash opens panels (`/plan show`, `/memory list`, `/diff`)
- **U6a.2** Default accent in `bin.ts` (cyan); `--no-color` flag
- **U6a.3** Transcript tool lines: dim + icon prefixes (`⚙ bash`, `✓ read_file`)

**Remaining (Round 5):**

| Slice | Round 5 | Scope |
|-------|---------|--------|
| U6a.4 | **R5.5** | Permission modal: bordered box + diff preview scroll |
| U6a.5 | **R5.6** | `/resume` picker panel; image blocks in composer hint |

**Out of scope for U6a:** Ink/Blessed, mouse support, pixel parity with Codex Rust TUI.

## U6b — IDE / desktop product shell (EnvoyMesh + adapter)

envoy-harness stays **protocol-first**; IDE polish lives in hosts.

| Host | Current | U6b target |
|------|---------|------------|
| **envoy-harness-tui** | ANSI EHUI | U6a panels + mesh rail (terminal daily driver) |
| **EnvoyGo / Tauri** | Pi chat + `pi:proposal` per tool | **EHUI side panel**: cluster rail, plan/memory/diff tabs consuming same ACP methods as TUI |
| **Ext Agent panel** | Slash + project folder RPC | Align slash palette with TUI (`/mesh`, `/plan`, …) |

**Contract (already exists):** `cluster/status`, `team/jobs`, `scoreboard/summary`, `discovery/event`, `session/plan`, `session/memory`, `git/diff`.

**Work items (EnvoyMesh repo):**

1. EHUI React panel — reuse `@envoymesh/envoy-harness-client` types; mirror TUI view bodies
2. Wire `setEnvoyHarnessProjectPath` + terminal session to harness cwd (started in Ext Agent)
3. Optional: embed `envoy-harness-tui --spawn` in terminal tab (heavy; defer)

**This monorepo:** keep `envoy-harness-adapter` MAP bridge; document EHUI consumer in `docs/envoy-harness-ui.md`.

## F2 — Windows sandbox (Package 1)

> **Round 6:** harden abort/cancel (`taskkill /T`), sidecar per-request
> cancel, doctor probe. Scaffolds for F2a–c already shipped; FS isolation
> (`fsIsolation: true`) remains deferred.

**Today:** Linux landlock + macOS seatbelt; Windows job + optional sidecar
scaffold; Round 6 closes process-tree kill gaps.

**`killProcessTree`:** lives in `@envoymesh/envoy-process` and is imported by
both Package 1 and `envoy-sandbox-win` (avoids mirroring across the
harness ↔ sandbox-win optional dependency edge).

**Codex reference:** `codex-rs/windows-sandbox-rs` sidecar for FS ACL isolation + job objects for process-tree lifecycle (`windows-sandbox-rs/src/bin/command_runner/win.rs`).

### F2 phases

| Phase | Deliverable | Effort |
|-------|-------------|--------|
| **F2a** | `windows-job-object` backend: native addon or thin FFI wrapper; `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; assign spawned bash children; hermetic tests on Windows CI | M |
| **F2b** | `WindowsSandboxExecutor` spawns `envoy-sandbox-win` sidecar (port Codex pattern): IPC spawn with restricted token/ACL profile from `SandboxPolicy` | L |
| **F2c** | Config: `sandbox_backend = "windows-sandbox"` in TOML; doctor probe; CLI `--sandbox-executor` mapping | S |

**F2a without native code (interim):** document that Node/libuv already assigns children to a kill-on-close job; enhance bash cancel to `taskkill /T` on Windows — **lifecycle only, not FS sandbox**.

**Schema addition (F2c):**

```toml
sandbox_backend = "windows-sandbox"   # maps to sidecar when available
```

**Tests:** Windows CI job; fake launcher pattern like `seatbelt.test.ts`.

## Sequencing recommendation

1. **U6a** (TUI tabs + colors) — terminal users, no new deps
2. **F2a** (Windows job lifecycle) — unblock Windows developers on cancel/cleanup
3. **U6b** EHUI panel in EnvoyGo — IDE parity path
4. **F2b** FS sidecar — true Codex-class Windows sandbox

## Success criteria

- Terminal: user sees tab strip, colored diff, plan/memory panels without reading `/help`
- Windows: `envoy-harness doctor` reports sandbox backend; bash runs under job object on win32
- IDE: EnvoyGo shows cluster rail + plan tab beside Pi chat (same data as TUI `/cluster` `/plan`)
