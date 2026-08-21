# AGENTS.md

This file is for **code agents** (Claude Code, envoy-harness itself, etc.) working on the **envoy-harness codebase**. It documents the build, test, and code conventions for *this repository*.

> **This is NOT the runtime `AGENTS.md` discovery feature.** The runtime feature discovers `AGENTS.md` files in user projects (e.g. `~/work/payments/AGENTS.md`) and feeds them to the agent as project context. That feature is part of the envoy-harness runtime (see `docs/design.md` §9). This file is for the code that builds envoy-harness itself.

## Build & test

```sh
pnpm install           # install deps
pnpm run typecheck     # tsc --noEmit
pnpm test              # vitest run (one-shot)
pnpm run test:watch    # vitest (watch mode)
pnpm run build         # tsc emit to dist/
pnpm run clean         # rm dist *.tsbuildinfo
```

Node version: **22+** (see `.nvmrc`). Engines field requires `>=22.19`.

## Code conventions

- **TypeScript strict mode** — every strictness flag in `tsconfig.json` is on (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, etc.). No exceptions.
- **ESM only** — `"type": "module"` in `package.json`, `NodeNext` module resolution. Use `.js` in relative imports (`from './foo.js'`), not `.ts`.
- **No EnvoyMesh-internal deps** in this package (Package 1). The mesh integration lives in `@envoymesh/envoy-harness-adapter` (in EnvoyMesh's monorepo, Package 3). The wire contract lives in `@envoymesh/protocol` (Package 2, in EnvoyMesh's monorepo). This package imports neither.
- **No runtime dependencies** at Phase 0. Add deps deliberately, with rationale. The first external dep likely lands in Phase 1.
- **Tests are independent** — every test must run without a mesh, a peer, a network, a `libp2p` daemon, an EnvoyMesh install, or a live LLM key. Mock everything. If a test needs a real mesh, it belongs in the adapter package, not here. **This is design target #4 — non-negotiable.**
- **Module size (Codex LOC rule)** — target modules under **500** lines; if a file exceeds roughly **800** lines, add new functionality in a **new module** instead of extending the file (unless there is a strong documented reason). Existing oversized modules are allowlisted in `scripts/module-size-allowlist.json`; CI (`scripts/check-module-size.mjs`) fails on new growth above 800. Removing an allowlist entry is a good sign.

## Project layout

```
.
├── src/                 # source code (TypeScript, ESM)
├── test/                # unit + smoke tests (vitest)
├── docs/                # the full design doc (en + zh)
├── .github/workflows/   # CI workflows
├── package.json         # @envoymesh/envoy-harness
├── tsconfig.json        # strict, ESM, NodeNext
├── tsconfig.build.json  # build-only config (src only, no test)
├── vitest.config.ts     # vitest configuration
├── .nvmrc               # 22
├── .gitignore
├── LICENSE              # Apache-2.0
└── README.md
```

See [`docs/design.md`](./docs/design.md) §18 for the full structural plan (the layout above is the Phase 0 slice; §18 shows the Phase 1+ target).

## PR conventions

- **One PR = one concern.** The first PR (this one) is the empty package skeleton. Subsequent PRs follow the design's phase plan.
- **PR titles follow conventional commits:** `chore:`, `feat:`, `fix:`, `refactor:`, `test:`, `docs:`.
- **All PRs go through the §21 test strategy:** unit + parity + e2e (when applicable). Phase 0 has only the smoke test.
- **The design doc is the source of truth** for architectural decisions. If a PR changes architecture, update the design doc in the same PR.
- **No commits or pushes by the agent.** Commits and pushes are the operator's responsibility.

## Communication with the design

When in doubt, the design doc (`docs/design.md`) wins. If a real-world constraint forces a deviation, the design doc gets updated in the same PR — never silently deviate.
