# @envoymesh/envoy-harness

> **Status (this package):** Phase 5 (mesh-native sub-agents) **complete**.
> The CLI agent in Package 1 is the reference implementation of MAP's
> `AgentRuntime = envoy-harness` value, and the only adapter that ships a
> full local sub-agent path. The mesh integration lives in
> [`@envoymesh/envoy-harness-adapter`](../envoy-harness-adapter) (Package 3)
> — a thin bridge, not a fork. **The package works without a mesh;**
> `npm install -g @envoymesh/envoy-harness` runs on a stock laptop.

EnvoyMesh's home-team agent harness. Production-grade CLI agent with four design targets, all load-bearing:

- **EnvoyMesh-native** — speaks the MAP protocol natively, sub-agents can run on any node in the mesh.
- **Independently runnable** — `npm install -g @envoymesh/envoy-harness` works without any mesh, any peer, any EnvoyMesh install.
- **Easy to integrate elsewhere** — any project can depend on this and write a ~500 LoC adapter against the stable `@envoymesh/protocol` contract.
- **Self-contained, fully independently testable** — test suite passes in complete isolation: no mesh, no peer, no network, no `libp2p` daemon, no live LLM key.

## What ships

| Capability | Status | Where |
|---|---|---|
| Agent loop + CLI | ✅ shipped | `src/agent.ts`, `src/cli.ts` |
| Permission modes (read-only / workspace-write / danger-full-access) + per-call approval | ✅ shipped | `src/permission/`, `src/agent.ts` |
| AGENTS.md discovery (walk-up + concat, override, byte budget) | ✅ shipped | `src/agents-md/` |
| 6 bash validators + auto-branch git | ✅ shipped | `src/bash/`, `src/tools/git.ts` |
| 12 hook events (Codex-compatible names) | ✅ shipped | `src/hooks/` |
| Verifier (rule / llm / cross sources, CompositeVerifier) | ✅ shipped | `src/verifier/` |
| Federated scoreboard + 3-tuple reputation | ✅ shipped | `src/scoreboard/`, `src/reputation/` |
| 5-step self-evolution (shadow default, owner-key signed) | ✅ shipped | `src/self-evolve/` |
| Per-call approval callback | ✅ shipped | `src/permission/approval.ts` |
| LSP client + 4 tools (types+managers, StdioLspClient, tools) | ✅ shipped | `src/lsp/` |
| Team + cron (TOML config, sequential, `${input}` substitution) | ✅ shipped | `src/team/`, `src/cron/` |
| `--json` trace + `AgentOptions.tracer` | ✅ shipped | `src/trace/` |
| Cross-agent verification (`CrossVerifyFn` + `defaultCrossVerify`) | ✅ shipped | `src/verifier/cross.ts`, `src/agent.ts` |
| **Mesh-native sub-agents** (Phase 5: `MeshSubmitter` seam, `LocalMeshSubmitter`, `task` tool, parallel fan-out + `maxSubagents=8`, `SubagentResultSigner`, `FanOutSpec` + capability-driven fan-out, cost aggregation, progress streaming, `subagentOf` trace annotation) | ✅ shipped | `src/subagent/` |
| `RemoteMeshSubmitter` (Package 3, thin wrapper over `RemoteSubmitterTransport`) | ✅ shipped | `packages/envoy-harness-adapter/src/remote-mesh-submitter.ts` |

**Phase 6 candidates** (deferred — see `docs/implementation-plan.md` §6.7): mesh-side `RemoteSubmitterTransport` impl, progressive disclosure for `AGENTS.md`, per-host tool install, streaming tool output, persistent session log, multi-tier fan-out, capability-driven cross-node routing. **Recommendation: don't start until a real use case surfaces** — "testability wins on tie" is the tie-breaker.

**Test count: 791 tests across 52 files** (envoy-harness 699 / 42 files + envoy-harness-adapter 92 / 10 files). All passing on `pnpm -r test`.

## Installation

```sh
npm install -g @envoymesh/envoy-harness
# or
pnpm add -g @envoymesh/envoy-harness
```

The mesh integration (`@envoymesh/envoy-harness-adapter`) is a separate, optional package — only install it when you want envoy-harness to participate in an EnvoyMesh mesh.

## Quickstart

```sh
envoy "explain this codebase"
envoy --plan "add a /healthz endpoint to the API"
envoy --sandbox=workspace-write "refactor the auth module"
envoy task "translate this doc to zh"   # mesh-native sub-agent (Package 1: local; Package 3: routed)
```

## Documentation

- [`docs/design.en.md`](./docs/design.en.md) — the full design (English, source of truth)
- [`docs/design.zh.md`](./docs/design.zh.md) — 中文版
- [`docs/boundary.en.md`](./docs/boundary.en.md) — package boundary one-pager (envoy-harness vs envoy-harness-adapter vs EnvoyMesh)
- [`docs/implementation-plan.md`](./docs/implementation-plan.md) — the single source of truth for **what shipped, where it lives, what's still open** (per-sub-chunk commit history + test inventory)
- The MAP protocol that envoy-harness speaks is defined in `EnvoyMesh/docs/agent-network-architecture.md` (in the EnvoyMesh repo, the predecessor design doc)

## Project layout

```
packages/
  envoy-harness/                          # Package 1: this package
    src/
      agent.ts          # the agent loop
      cli.ts            # the `envoy` command
      subagent/         # Phase 5: mesh-native sub-agents (MeshSubmitter seam)
      lsp/              # LSP client + 4 tools
      hooks/            # 12 hook events
      verifier/         # rule/llm/cross verifier
      scoreboard/       # federated scoreboard
      self-evolve/      # 5-step self-evolution
      ...               # other capability seams
    test/               # unit + smoke tests
    docs/               # design, boundary, implementation-plan
    .github/            # CI workflows
  envoy-harness-adapter/                  # Package 3: the mesh bridge
    src/
      adapter.ts          # EnvoyHarnessAdapter (MAP AgentAdapter reference impl)
      remote-mesh-submitter.ts  # F10.3.2: thin wrapper over RemoteSubmitterTransport
      ...
```

## Building from source

```sh
pnpm install
pnpm run typecheck     # both packages
pnpm -r test           # both packages (791 tests)
pnpm -r build          # both packages
```

Node 22+ (see `.nvmrc`).

## License

Apache-2.0. See [LICENSE](./LICENSE).
