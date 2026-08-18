# envoy-harness

> **Monorepo.** This repo contains EnvoyMesh's home-team agent harness and
> its adapters. Each package is independently published and consumed.
>
> **Status as of 2026-08-18:** the harness is at v0 spine + LLM adapters
> (Phase 1 + Phase 2 prerequisites done). Phase 2 proper (the MAP adapter
> in `@envoymesh/envoy-harness-adapter`) is in progress.

## Packages

| Package | Status | Description |
|---|---|---|
| [`@envoymesh/envoy-harness`](./packages/envoy-harness/README.md) | ✅ v0.1+ | The home-team agent harness. Production-grade CLI agent, EnvoyMesh-native, independently runnable. The 3-package design target #2 (independently runnable) means this is the foundation. |
| [`@envoymesh/envoy-harness-adapter`](./packages/envoy-harness-adapter/README.md) | 🟡 F8 in progress | The reference MAP adapter (Package 3). Bridges envoy-harness to EnvoyMesh's manifest broadcast, task submission, and the 3-tuple reputation book. See [`docs/improving-agent-network.en.md`](https://github.com/allenpeng0705/EnvoyMesh) §5.2 for the protocol spec. |

## Layout

```
.
├── packages/
│   ├── envoy-harness/              # Package 1 — the CLI agent
│   │   ├── src/                    # public API
│   │   ├── test/                   # 488 tests across 24 files
│   │   ├── bin/                    # bin/envoy-harness.ts
│   │   └── docs/                   # design.{en,zh}.md + implementation-plan.md
│   └── envoy-harness-adapter/      # Package 3 — MAP adapter (F8)
├── .github/
│   └── workflows/ci.yml            # pnpm -r typecheck + test + build
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json                    # workspace root (private)
└── LICENSE
```

## Commands

```sh
pnpm install            # workspace install (hoists dev deps)
pnpm run typecheck      # tsc --noEmit across all packages
pnpm run test           # vitest run across all packages
pnpm run build          # tsc -p tsconfig.build.json across all packages
pnpm run envoy          # run the bin script (envoy-harness)
```

Per-package commands (use `--filter`):

```sh
pnpm --filter @envoymesh/envoy-harness run test
pnpm --filter @envoymesh/envoy-harness-adapter run typecheck
```

## Design

- Design doc: [`packages/envoy-harness/docs/design.en.md`](./packages/envoy-harness/docs/design.en.md) (English, source of truth) + `design.zh.md` (Chinese mirror).
- Implementation plan: [`packages/envoy-harness/docs/implementation-plan.md`](./packages/envoy-harness/docs/implementation-plan.md) — the master reference for "what shipped, what's next".
- MAP protocol: EnvoyMesh monorepo's `docs/improving-agent-network.en.md`.

## Stability

- Pre-release: this monorepo is **pre-release**. Per the AGENTS.md stance, "remove the pre-release section at the first tagged release". Until then: rename or repackage freely; update every reference together; the SQLite `SCHEMA_VERSION` is monotonic; on-disk formats are rejected if stale.
- Each package's API surface is the contract. Additive changes don't bump the major; non-additive changes do.
