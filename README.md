# @envoymesh/envoy-harness

> **Status: Phase 0 — empty package.** No implementation yet. See [`docs/design.md`](./docs/design.md) for the full design.

EnvoyMesh's home-team agent harness. Production-grade CLI agent with four design targets, all load-bearing:

- **EnvoyMesh-native** — speaks the MAP protocol natively, sub-agents can run on any node in the mesh.
- **Independently runnable** — `npm install -g @envoymesh/envoy-harness` works without any mesh, any peer, any EnvoyMesh install.
- **Easy to integrate elsewhere** — any project can depend on this and write a ~500 LoC adapter against the stable `@envoymesh/protocol` contract.
- **Self-contained, fully independently testable** — test suite passes in complete isolation: no mesh, no peer, no network, no `libp2p` daemon, no live LLM key.

## Installation

```sh
npm install -g @envoymesh/envoy-harness
# or
pnpm add -g @envoymesh/envoy-harness
```

## Quickstart (Phase 1+)

```sh
envoy "explain this codebase"
envoy --plan "add a /healthz endpoint to the API"
envoy --sandbox=workspace-write "refactor the auth module"
envoy task "translate this doc to zh"   # mesh-native sub-agent
```

## Documentation

- [`docs/design.md`](./docs/design.md) — the full design (English)
- [`docs/design.zh.md`](./docs/design.zh.md) — 中文版
- The MAP protocol that envoy-harness speaks is defined in `EnvoyMesh/docs/agent-network-architecture.md` (in the EnvoyMesh repo, the predecessor design doc)

## Project layout

```
src/        # source code
test/       # unit + smoke tests
docs/       # the full design doc (en + zh)
.github/    # CI workflows
```

See [`docs/design.md`](./docs/design.md) §18 for the full structural plan.

## Building from source

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Node 22+ (see `.nvmrc`).

## License

Apache-2.0. See [LICENSE](./LICENSE).
