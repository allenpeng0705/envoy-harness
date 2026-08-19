# envoy-harness 与 EnvoyMesh 的边界

> **目的。** 把两个包之间的边界讲清楚，省得每次都要问"这个放
> envoy-harness 还是 EnvoyMesh？"。**本文档是边界的唯一权威；
> 不确定时以本文档为准。**

> 配套：[`boundary.en.md`](./boundary.en.md)（英文版，源文档）。

---

## 一条总规则

**envoy-harness 是本地 agent 运行时。EnvoyMesh 是 mesh 网络层。**

envoy-harness 产出类型化、文档齐全、可本地运行的接口。EnvoyMesh 通过
adapter 消费这些接口。两者之间**只通过一个**包连接：
`envoy-harness-adapter`（Package 3）。

| 层 | 拥有什么 | 不拥有什么 |
|----|---------|-----------|
| **envoy-harness（Package 1）** | 本地 agent 循环、类型系统、内建能力、`MeshSubmitter` 接口、`LocalMeshSubmitter` | mesh 协议、peer 发现、libp2p、跨运行时 adapter、前端 UI、mesh 状态持久化 |
| **envoy-harness-adapter（Package 3）** | 桥接：`EnvoyHarnessAdapter`（mesh 侧契约）、`RemoteMeshSubmitter`、`defaultBuildAgent`、`defaultSignResult`、`defaultCrossVerify` | 不与 envoy-harness 和 mesh 同时打交道的东西 |
| **EnvoyMesh（同仓 monorepo）** | mesh 网络：libp2p、peer 发现、能力广播、跨运行时 adapter（`OpenClawAdapter`）、chain / verdict 账本、Tauri UI | 本地 agent 循环、类型系统、本地 hook/tool/verifier 注册表 |

---

## envoy-harness（Package 1）应该装什么

- **agent 循环** — `Agent.run`、消息处理、tool 执行、cost 追踪。
- **类型系统** — `Message`、`ContentBlock`、`ToolCall`、`ToolResult`、
  `AgentResult`、`SubagentInput`、`SubagentResult`、`MeshSubmitter`。
- **内建能力** — bash、read_file、hook 注册表、verifier（6 条规则）、
  `CostTracker`、`LspManager` + 4 个 LSP 工具、`Tracer` + `JsonLinesTracer`、
  `Team`、`task` 工具。
- **sub-agent 的本地实现** — `LocalMeshSubmitter` 在一个**新的**本地
  session 里跑子 agent（独立的 id、AGENTS.md、hooks、permission）。
  **即使是本地的 sub-agent 也是独立 session**（设计不变量 #9），
  所以未来的 `RemoteMeshSubmitter` 可以无缝替换。
- **Skill 描述** — `ENVOY_HARNESS_SKILLS` 目录（F8.1）、`SkillDescriptor`
  类型。本地"这个 runtime 能干什么"的目录。

---

## envoy-harness 不应该装什么

- **libp2p / mesh 网络** — peer 发现、dial、relay、circuit relay。
- **跨 peer 协议封装** — 跨节点 sub-agent 提交、能力广播、peer 消息
  的线协议格式。
- **能力广播** — agent-adapter-broadcast 机制在 EnvoyMesh
  （`agent-adapter-broadcast.ts`）。
- **跨运行时 adapter** — 例如 `OpenClawAdapter`、Pi/Penguin/Codex
  桥接。这些翻译 EnvoyMesh 的线协议与另一个 runtime 的 API。
  它们在 EnvoyMesh，因为它们跟 mesh 打交道。
- **前端 UI** — Tauri app、web UI、任何给用户渲染的东西。
- **mesh 状态持久化** — peer store、key store、verdict 账本、identity。
  这些是 mesh 层的事。

---

## 桥接：`envoy-harness-adapter`（Package 3）

**`envoy-harness-adapter` 是唯一同时知道 envoy-harness 和 mesh 的地方。** 它：

- 把 envoy-harness 的 `Agent` 包成 `AgentAdapter`（mesh 侧契约：
  `agent-adapter.ts:AgentAdapter`）。
- 提供 `defaultBuildAgent({ model, tools, ... })` — 宿主注入构建策略；
  adapter 按需创建 `Agent` 实例。
- 提供 `defaultSignResult({ ownerKey })` — 宿主注入签名密钥；
  adapter 在返回前对 `SkillResult` 签名（Ed25519）。
- 提供 `defaultCrossVerify(otherAdapter)` — 用不同 adapter 做跨 agent
  验证。
- 提供 `EnvoyHarnessAdapter.execute()` — mesh 侧入口，把 mesh 来的
  `SubmitRequest` 转成本地调用，返回 `SubmitResult`。
- （F10.3）提供 `RemoteMeshSubmitter` — `MeshSubmitter` 的实现，
  通过注入的 `RemoteSubmitterTransport` 把 sub-agent 提交到远程节点。

依赖方向严格如下：

```
EnvoyMesh ──→ envoy-harness-adapter ──→ envoy-harness
```

envoy-harness 完全没有 import envoy-harness-adapter 或 EnvoyMesh。
envoy-harness-adapter 完全没有 import EnvoyMesh（只 import envoy-harness）。
EnvoyMesh 两边都 import，但只通过公开 API。

---

## 桥接在代码里

| 关注点 | 放在哪 | envoy-harness 导出 | envoy-harness-adapter 提供 |
|--------|-------|-------------------|---------------------------|
| 构建一个 agent | `agent.ts:Agent` + `EnvoyHarnessAdapterInput.buildAgent` | `Agent`、`AgentOptions` | `defaultBuildAgent({ model, tools, cwd, hooks, ... })` |
| 给结果签名 | `LocalMeshSubmitter`（v0: 空）+ `EnvoyHarnessAdapter`（真 Ed25519） | `SubagentResult.signature: string` | `defaultSignResult({ ownerKey })` → 闭包 |
| 验证结果 | `runLocalVerifier`（6 条规则）+ `verify()`（本地 + 跨拼接） | 6 条 verifier 规则 | `EnvoyHarnessAdapter.verify()` |
| 跨验证 | `defaultCrossVerify(otherAdapter)` | 6 条 verifier 规则 | `defaultCrossVerify(otherAdapter)` |
| 本地提交 sub-agent | `LocalMeshSubmitter` | `MeshSubmitter` 接口、`LocalMeshSubmitter` | n/a（Package 1 拥有） |
| 远程提交 sub-agent | `RemoteMeshSubmitter`（F10.3） | `MeshSubmitter` 接口 | `RemoteMeshSubmitter`（用注入的 `RemoteSubmitterTransport`） |
| Federated routing（哪个 peer） | mesh 侧：`agent-adapter-broadcast.ts`、peer 发现 | `SubagentInput.preferredPeerId?: string`（提示，不是路由决定） | n/a（路由在 EnvoyMesh） |

**接口** 在 envoy-harness。**默认本地实现** 在 envoy-harness。**mesh 侧实现**
在 envoy-harness-adapter。**mesh 网络** 在 EnvoyMesh。

---

## 5 个 deferred 事项（映射到边界）

这是 agent network improvement 里 deferred 的 5 个事项。每一个都映射到
拥有它的层。

| # | 事项 | 层 | 为什么不在 envoy-harness |
|---|------|----|-------------------------|
| 1 | "Registrations are effects" | **EnvoyMesh** | envoy-harness 是单 runtime。这个模式在多个 adapter 类型在生产中注册时才重要 — 那是 mesh 世界。可以作为 envoy-harness 文档里的设计原则（镜像 JSONL append-only 模式到注册表层），但在 EnvoyMesh 需要之前没代码工作。 |
| 2 | HMR / 热重载 | **EnvoyMesh** | 重广播机制在 EnvoyMesh（`agent-adapter-broadcast.ts`）。envoy-harness 没有广播面。"触发重广播的 live reload 缝"是 mesh adapter 关注的事。 |
| 3 | Agent Skills 标准 | **EnvoyMesh** | 跨运行时标准在 mesh 边界（`OpenClawAdapter`）。envoy-harness 的工作是**保持产出稳定、类型良好的 skill 面**（`SkillDescriptor`），让 adapter 有好东西可转。 |
| 4 | Trace observability UI | **独立前端项目** | 前端。envoy-harness 产出 trace 数据（F9.4 `JsonLinesTracer` + F8.6+ verdicts）；UI 消费。"Second-doctor / verdict 写路径" 缺口现在关上了 — envoy-harness 是数据源。 |
| 5 | run_subagent 干净 API | **已交付（F10）；暴露在 EnvoyMesh** | F10.1 + F10.2 就是干净 API：`MeshSubmitter.submit`、`LocalMeshSubmitter`、`task` 工具、并行扇出、cap。暴露在 `EnvoyHarnessAdapter` 调用 envoy-harness API 以服务远程请求。 |

---

## 心智模型

- **envoy-harness 是"如果给 mesh-native 世界从零写一个 Codex/Claude Code
  会是什么样"** — 本地循环、本地类型系统、本地能力、本地 sub-agent。
- **envoy-harness-adapter 是让 envoy-harness 能塞进 P2P mesh 的包装**
  — 在本地循环和 mesh 侧契约之间翻译。
- **EnvoyMesh 就是 mesh 本身** — peers、发现、路由、跨运行时桥接、
  持久化、UI。

**判断口诀：单机能跑不下来的不进 envoy-harness。不跟 envoy-harness 打交道
不进 envoy-harness-adapter。不跟 mesh 打交道不进 EnvoyMesh。**
