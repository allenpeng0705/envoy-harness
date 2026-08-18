# @envoymesh/envoy-harness

> **状态:Phase 0 —— 空 package。** 还没有实现。完整设计见 [`docs/design.md`](./docs/design.md)。

EnvoyMesh 的 home-team agent harness。生产级 CLI agent,有四个设计目标,都是硬约束:

- **EnvoyMesh-native** —— 原生说 MAP 协议,sub-agent 可以在 mesh 上任何节点跑。
- **可独立运行** —— `npm install -g @envoymesh/envoy-harness` 不需要任何 mesh、任何 peer、任何 EnvoyMesh 安装就能跑。
- **易集成到别处** —— 任何项目都可以依赖本 package,然后对着稳定的 `@envoymesh/protocol` contract 写约 500 LoC 的 adapter。
- **自包含、可完全独立测试** —— 测试套件在完全隔离下通过:没有 mesh、没有 peer、没有网络、没有 `libp2p` 守护进程、没有活的 LLM key。

## 安装

```sh
npm install -g @envoymesh/envoy-harness
# 或
pnpm add -g @envoymesh/envoy-harness
```

## 快速上手(Phase 1+)

```sh
envoy "explain this codebase"
envoy --plan "add a /healthz endpoint to the API"
envoy --sandbox=workspace-write "refactor the auth module"
envoy task "translate this doc to zh"   # mesh-native sub-agent
```

## 文档

- [`docs/design.md`](./docs/design.md) —— 完整设计(英文)
- [`docs/design.zh.md`](./docs/design.zh.md) —— 中文版
- envoy-harness 说的 MAP 协议在 `EnvoyMesh/docs/agent-network-architecture.md` 里定义(在 EnvoyMesh 仓库里,这是前置设计文档)

## 项目布局

```
src/        # 源代码
test/       # 单元 + smoke 测试
docs/       # 完整设计文档(en + zh)
.github/    # CI workflow
```

完整结构计划见 [`docs/design.md`](./docs/design.md) §18。

## 从源码构建

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Node 22+(见 `.nvmrc`)。

## 许可证

Apache-2.0。见 [LICENSE](./LICENSE)。
