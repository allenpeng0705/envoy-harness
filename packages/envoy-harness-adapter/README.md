# @envoymesh/envoy-harness-adapter

> **Status:** F8 in progress (Phase 2 per design §22). The package
> scaffold is in place; the adapter class lands in F8.1+.

The reference MAP adapter for EnvoyMesh's home-team agent harness.
Implements `AgentAdapter` from `@envoymesh/agent-adapter`. The
adapter is a thin bridge that knows about both envoy-harness
(Package 1) and the EnvoyMesh mesh; envoy-harness itself stays
mesh-agnostic.

## Layout

```
src/
  index.ts          # public surface (F8.0: just the version constant)
  skills.ts         # F8.1: ENVOY_HARNESS_SKILLS catalog
  translation.ts    # F8.3: local ↔ wire type translation
  adapter.ts        # F8.2/4/5: EnvoyHarnessAdapter class
test/
  smoke.test.ts     # F8.0: smoke test
```

## Setup

This package depends on the EnvoyMesh monorepo's `protocol`,
`agent-adapter`, and `identity` packages. They are referenced via
pnpm's `link:` protocol, pointing at `../EnvoyMesh/packages/*`.
Clone EnvoyMesh as a sibling repo:

```sh
git clone https://github.com/allenpeng0705/EnvoyMesh.git ../EnvoyMesh
cd ../EnvoyMesh
pnpm install
pnpm -r run build         # produces packages/*/dist
cd ../envoy-harness
pnpm install
```

If the EnvoyMesh monorepo lives elsewhere on your machine, update
the `link:` paths in this package's `package.json`.

## Public API

The package exports are additive. The first exports are:

- `ENVOY_HARNESS_ADAPTER_VERSION` — the package version.

Future exports (F8.1+):

- `ENVOY_HARNESS_SKILLS` — the 5-skill catalog.
- `EnvoyHarnessAdapter` — the adapter class.
- `EnvoyHarnessAdapterInput` — constructor options.

## Stability

Pre-release. The EnvoyMesh monorepo's protocol packages (`protocol`,
`agent-adapter`, `identity`) are themselves pre-release; their
schemas evolve with the design. When those packages bump versions,
this adapter follows.
