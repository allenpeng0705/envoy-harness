# envoy-harness v0 —— 设计文档

> EnvoyMesh 的 home-team agent。Mesh Adapter Pattern(MAP)的 reference 实现。**为一个目标而生:成为 EnvoyMesh mesh 里最 production-ready 的 CLI agent。**
>
> 配套文件:[`envoy-harness-design.en.md`](./envoy-harness-design.en.md)(英文版,source of truth)
>
> 这份设计读过的源码:
> - [`../../codex`](../../codex) —— production Codex CLI,Rust 实现(`codex-rs/core/src/agents_md.rs:1-90`、`protocol/src/config_types.rs:86-96`、`protocol/src/protocol.rs:915-939`、`core/src/hook_runtime.rs:1-32`)
> - [`../../claw-code`](../../claw-code) —— Claude Code Rust port,显式 9-lane parity harness(`PARITY.md`、`rust/crates/runtime/src/permission_enforcer.rs`)
> - [`../../deepseek-harness`](../../deepseek-harness) —— Cordis、形式化 effect tracking、capability seam
> - [`../../penguin-harness`](../../penguin-harness) —— 5 步自进化、scoreboard、污染防护
> - [`../../pi`](../../pi) —— 极简扩展模型、TaggedError、Agent Skills 标准
> - [`./improving-agent-network.en.md`](./improving-agent-network.en.md) —— MAP 协议、三元组 reputation、联邦 scoreboard

> **状态(以 `phase-1/types` 上最新 commit 为准):**
> - **Phase 0**(空 package)—— ✅ shipped
> - **Phase 1**(v0 主干)—— ✅ shipped(Chunks 1–4d)
> - **Phase 2**(mesh-native adapter)—— ✅ shipped(F7 + F8,monorepo restructure + `@envoymesh/envoy-harness-adapter`)
> - **Phase 3**(自进化)—— ✅ shipped(5a–5e + F6 federated scoreboard)
> - **Phase 4**(生产级)—— ✅ shipped(F9.1 per-call approval、F9.2 LSP、F9.3 team + cron、F9.4 `--json` trace、F9.5 跨 agent 验证)
> - **Phase 5**(mesh-native sub-agents)—— ✅ shipped(F10.1 `MeshSubmitter` + `LocalMeshSubmitter` + `task` tool、F10.2 parallel fan-out + `maxSubagents=8` cap、F10.3 signer + `RemoteMeshSubmitter` + `RoutingHint`、F10.4 `FanOutSpec` + capability-driven fan-out、F10.5 cost aggregation + progress streaming、F10.6 `subagentOf` trace annotation)
>
> **本文档是什么:** 设计 —— what 和 why,带 code-shape 的 sketch 覆盖 load-bearing 表面。
> **本文档不是什么:** 实现记录(per-sub-chunk commit 历史、per-module test inventory)—— 见 [`docs/implementation-plan.md`](./implementation-plan.md)。Boundary doc [`docs/boundary.en.md`](./boundary.en.md) 是 package 拆分的一页纸说明。
>
> **测试数:791 个测试,跨 52 个文件**(Package 1:699/42;Package 3:92/10)。`pnpm -r test` 全部通过。
>
> 下面带 **shipped in Phase 5** 标记的小节描述 mesh-native sub-agents 的最终形态;§10.3 / §15 的 sketch 早于实现,保留它们是为了保留设计意图,不是 source-of-truth 代码。要看代码,见 `packages/envoy-harness/src/subagent/` 和 `packages/envoy-harness-adapter/src/remote-mesh-submitter.ts`。

---

## 0. 如何读这份文档

这是一份长文档。不同读者需要不同部分。

| 如果你是... | 读 | 然后回来读 |
|---|---|---|
| **新贡献者** 加 tool 或 permission mode | §1、§2、§5、§6、§17(file layout)、§20(config)| §11(adapter)当你要碰 MAP 时 |
| **评审者** 评估这个设计 | §1、§2、§3、§23(decisions)| §22(open questions)|
| **用户** 想理解 envoy-harness 是什么 | §1、§2(end-to-end)、§18(CLI)、§19(config)| §13(自进化)高级用法 |
| **实现者** 造 v0 | 全部,按顺序 | — |

**如果你什么都不读,就读 §1(战略定位)和 §2(端到端例子)。** 这是仅有的两节,少读会有害。

---

## 1. 战略定位

EnvoyMesh 是 P2P mesh 节点网络。每个节点**一次跑一个 agent runtime** —— OpenClaw、Pi、Hermes、Codex,或未来的 **envoy-harness**。今天我们对那些外部 runtime 没有控制权,它们的演进属于它们各自的维护者。

envoy-harness 是 **home-team agent**。它是 MAP 协议的 reference 实现,也是第一个消费完整 envelope 的 adapter。**它不是"系统 agent"** —— 它跟每个其他 adapter 一样竞争同一批 task,遵循同样的 reputation 规则。它有而别人没有的是:

- **Mesh-native 执行**:sub-agents 可以在 mesh 上任何节点跑(其他 harness 都是 local-only)
- **联邦自进化**:verifier 规则可以在跑 envoy-harness 的节点之间 opt-in 共享
- **三元组 reputation**:per `(peer, runtime=envoy-harness, skillId)` 的 track record,其他 runtime 没法占用

envoy-harness 就为了一件事:**成为 EnvoyMesh mesh 里最 production-ready 的 CLI agent**。它从 Codex CLI 和 Claude Code 借 UX,从 DeepSeek-Harness 借纪律,从 Penguin 借自进化。它**原生**说 MAP 协议 —— 没有翻译层。

> **四个设计目标 —— 不可妥协,不是可权衡的取舍**:
>
> 1. **EnvoyMesh-native。** envoy-harness 原生说 MAP。Sub-agent 可以在 mesh 上任何节点跑。
>    联邦自进化、三元组 reputation、chain orchestrator 集成是一等公民 —— 不是后加的。
> 2. **可独立运行。** `npm install -g @envoymesh/envoy-harness` 不需要任何 mesh、任何 peer
>    节点、任何 EnvoyMesh 安装就能跑。一个独立开发者开箱即用获得 production-grade CLI agent。
> 3. **易集成到别处。** 任何想要"MAP 风格 mesh"的项目都可以依赖 Package 1,然后对着
>    稳定的 `@envoymesh/protocol` contract 写约 500 LoC 的 Package 3。不需要 fork、不需要
>    重写、不需要从 EnvoyMesh 内部逃逸。
> 4. **自包含、可完全独立测试。** Package 1 的测试套件在完全隔离下通过:没有 mesh、
>    没有 peer、没有网络、没有 `libp2p` 守护进程、没有 EnvoyMesh 安装、不需要活的 LLM key。
>    Mock LLM、mock adapter、mock verifier。CI 在沙箱里每次 commit 跑全套;harness 本身是
>    被测系统,没有别的。**如果一个测试需要真的 mesh,它属于 Package 3 的测试套件,
>    不在这里。** 这就是 envoy-harness 能被其他项目当库用的原因。
>
> 这四条在每个设计决策处都被检查。一个 feature 如果改善一条以牺牲另一条为代价,就不 ship。
> 拿不准的时候,目标 4(可测试性)赢,因为其他三条都依赖它。
>
> **前置文档(承载契约的硬约束)**:本设计遵循 `envoymesh-design/improving-agent-network.{en,zh}.md`
> 里定义的契约。**所有 wire 级细节都来自那份文档,这里不重新定义**:
>
> - `AgentAdapter` interface(§5.1)
> - `CapabilityManifest` / `AgentResult` / `Verdict` schemas(§4)
> - `AgentRuntime` 枚举 —— envoy-harness 是第一个 adapter 是 canonical(不是 sketch)的 runtime 值
> - 三元组 reputation key 形态 `(peer, runtime=envoy-harness, skillId)`(§7)
> - `CompositeVerifier` 规则组合:OR-of-pass、AND-of-fail、默认 disputed(§6.2)
> - 跨 agent 验证流:two-doctor 模式(§8)
> - 联邦自进化:本地 scoreboard + opt-in 联邦(§9)
> - Adapter 契约:envelope 用 owner key 签名,不是 adapter key
>
> 本文档和前置文档冲突时,**wire 细节以前置文档为准**;本文档对 envoy-harness
> 内部形态(permission、hook、AGENTS.md、verifier rule 集、agent loop、CLI)有最终解释权。
> 两份文档被设计为一起读;只读其中一份会漏掉一半画面。

### 1.1 envoy-harness **不是**什么

- **不是替代** OpenClaw、Pi、Hermes 或 Codex。它们继续被支持。
- **不是"系统 agent"** 享受特权访问。它跟每个其他 adapter 一样竞争同一批 task。
- **不是 wrapper**。envoy-harness 是全新实现,不是某个工具的薄壳。
- **不绑在单一 model provider**。envoy-harness 从 day 1 就支持多 provider;Anthropic、OpenAI、Ollama、自定义端点都是 first-class。
- **不是 UI 应用**。envoy-harness 是 CLI。Web UI 和 IDE 集成是分开的 consumer,可以把 envoy-harness 当库用。
- **不绑在 EnvoyMesh**。envoy-harness 作为独立 package ship(`@envoymesh/envoy-harness`)。EnvoyMesh mesh 集成是独立的、可选的 adapter package。其他项目可以直接采用 envoy-harness,不需要 EnvoyMesh。

### 1.2 envoy-harness 独有的能力

三个现在没有其他 agent harness 能提供的能力:

1. **每个 EnvoyMesh feature 的第一个 consumer。** 当 MAP 加新字段,envoy-harness 就用。当 chain orchestrator 增长新 sub-step,envoy-harness 就跑。**Home-team agent 永远站在 mesh 的最前沿**。
2. **可审计的、不是魔法的自进化纪律。** verifier ruleset 的每次修改都走 5 步协议,owner 私钥签 scoreboard entry。Optimizer 永远看不到 rubric。
3. **可分叉的 reputation 系统。** 跑 envoy-harness 的节点累积 `(peer, runtime=envoy-harness, skillId)` reputation,其他节点能读、能信。这个 reputation 不能被其他 runtime 用 —— 它是 envoy-harness 的护城河。

### 1.3 Repository 策略(独立 ship,后整合)

envoy-harness 作为**独立 npm package** 构建,可选地跟 EnvoyMesh 集成。模式跟 Codex CLI(npm-installable,OpenAI infra 分开)和 Claude Code(npm-installable,Anthropic API 分开)一样。**CLI 是用户面的产品;mesh 是分开的关注点。**

#### 1.3.1 三个 package

```
Package 1: @envoymesh/envoy-harness
  Lives: 在它自己的 repo,或 EnvoyMesh monorepo 里严格隔离的 package
  Depends on: 任何 EnvoyMesh-internal 的东西都不依赖
  Published: 是 —— npm install -g @envoymesh/envoy-harness
  Ships: cli、hooks、AGENTS.md、verifier、5 步自进化、local tools
  Tested: 不需要 mesh;mock LLM;mock adapters
  Users: 开发者、CI pipeline、任何想要 CLI agent 的人

Package 2: @envoymesh/protocol
  Lives: EnvoyMesh 的 monorepo 里
  Published: 是 —— 有版本、contract-stable
  Contains: AgentAdapter interface、manifest/result/verdict schemas
  envoy-harness 和 EnvoyMesh 都依赖它
  这是它们之间的 *contract*

Package 3: @envoymesh/envoy-harness-adapter
  Lives: EnvoyMesh 的 monorepo 里
  Depends on: envoy-harness + protocol + libp2p + EnvoyMesh internals
  Size: ~500 LoC
  Contains: 桥 —— 为 envoy-harness 实现 AgentAdapter
  Does: 把 manifest 广播到 mesh,把 task 提交给 chain orchestrator,
        从 ArbitrationStore 读 verdict
  Tested: 同时跟 envoy-harness 和 EnvoyMesh 对测,带 mock
  envoy-harness 里唯一知道 mesh 存在的代码
```

#### 1.3.2 这样分能换来什么

- **独立 ship 节奏。** envoy-harness 可以按自己的时间表 release。EnvoyMesh 不卡 envoy-harness 的进度。
- **不需要 mesh。** 用户能 `npm install -g @envoymesh/envoy-harness` 本地使用,根本不用跑 EnvoyMesh。
- **其他项目能采用 envoy-harness。** Code-server、IDE、CI pipeline,或假设的 "XMesh" 都能用 Package 1,可选地写他们自己的 Package 3 等价物。
- **基于 mock 的测试。** envoy-harness 测试跑 mock adapter;EnvoyMesh 测试跑 mock adapter;**真 adapter 是唯一两边都碰的东西**。
- **故障隔离。** 如果 EnvoyMesh 开发卡住,envoy-harness 继续。如果 envoy-harness 有 bug,EnvoyMesh 不受影响。

#### 1.3.3 代价

- **多一个 contract 要维护。** `@envoymesh/protocol` 变成 published、版本化的 package。Breaking change 是协调成本。
- **两个 CI,两个 release 流程。** envoy-harness 和 EnvoyMesh 各自有。Adapter 放在 EnvoyMesh 的 CI 里。
- **API drift 风险。** 如果 envoy-harness 给 `AgentAdapter` 加了新方法,EnvoyMesh 跟进慢,contract 就破了。缓解:contract 测试在 **两个** repo 里;两边都过才能 release。

#### 1.3.4 不变的东西

- **MAP 协议本身**(`@envoymesh/protocol`)。已经为稳定 contract 设计的。
- **AgentAdapter interface**。这是 single seam;两边都对着它实现。
- **三元组 reputation 的 key**。`(peer, runtime=envoy-harness, skillId)` 是 envoy-harness 写的格式;其他 runtime 写自己的 key。
- **Scoreboard 格式**。`verifier-scoreboard.yaml` 是 envoy-harness 的;EnvoyMesh 不读它。

#### 1.3.5 这个策略下的 release 时间线

```
Month 1-2:  envoy-harness 独立 ship(Package 1,没 mesh 集成)
            ↓ 用户能 `npm install -g @envoymesh/envoy-harness` 用
Month 3:    @envoymesh/protocol 稳定并发布(Package 2)
            envoy-harness 依赖 Package 2(它的 manifest/verdict 类型)
Month 4:    @envoymesh/envoy-harness-adapter(Package 3)在 EnvoyMesh 里 ship
            装上它:envoy-harness 能通过 libp2p 广播 manifest
Month 5+:   envoy-harness 和 EnvoyMesh 各自独立迭代
            adapter 跟着 protocol 的 minor version 走
```

**关键优势**:到 Month 2,envoy-harness 已经在用户手里了。Mesh 集成是 *progressive enhancement*,不是 *prerequisite*。

---

## 2. 端到端例子

在进入任何设计细节之前,这里有一个 user story 跑通整个系统。用它来锚定后面所有内容。

### 2.1 user story

Alice 是后端工程师。她的节点跑 envoy-harness(默认,她没改配置)。她在项目根启动一个 session,这个项目是一个 git repo,有两个 AGENTS.md —— 一个在项目根,一个在 `services/auth/`。

```
~/work/payments/    ← cwd(项目根,有 .git)
├── AGENTS.md       ← "always run tests before commit"
├── services/
│   ├── auth/
│   │   ├── AGENTS.md  ← "this service uses jose for JWTs"
│   │   └── src/auth.ts
│   └── payments/
│       └── src/charge.ts
```

她跑:

```
envoy "refactor the auth module to use jose instead of jsonwebtoken, and add a test for the new token shape"
```

### 2.2 一步步发生什么

```
1. argv 解析 (cli.ts)
   - --sandbox(默认 read-only)
   - --approval(默认 on-request)
   - --cwd(默认 process.cwd)
   → 构造一个 SessionConfig

2. AGENTS.md discovery (agents-md/discover.ts)
   - findProjectRoot("~/work/payments", [".git"]) → "~/work/payments"
   - collectDocPaths(projectRoot, cwd, ["AGENTS.md"])
     → ["~/work/payments/AGENTS.md", "~/work/payments/services/auth/AGENTS.md"]
   - 读每个,尊守 32 KB 预算
   - 检查 cwd 有没有 AGENTS.override.md → 没有
   → LoadedAgentsMd,两个 project docs,1.2 KB 总

3. config load (config/loader.ts)
   - 读 $ENVOY_HOME/agent-state/<peer>/config.toml
   - 用 Zod schemas 解析 TOML
   - 解析 profile(没配 → 用 inline config)
   - 验证:permission_mode=read-only, ask_for_approval=on-request
   → ResolvedConfig

4. permission 解析 (permissions/mode.ts)
   - mode = read-only
   - approval = on-request
   - backend = auto-detect → linux-landlock
   - writable_roots = [](read-only 下不需要)
   → SandboxPolicy

5. hook setup (hooks/registry.ts)
   - 读 $ENVOY_HOME/agent-state/<peer>/hooks.toml
   - 给每个事件注册 handlers
   - 加载 12 个默认空 handlers
   → HookRegistry

6. session start (session.ts)
   - state = LOADING
   - 发 SessionStart hook
   - 初始化 cost tracker
   - state = ACTIVE
   → Session

7. turn 循环 (agent.ts)
   loop:
     7a. 构造 context:
         - 加载 AGENTS.md(从 step 2)
         - 加载 session history
         - 调 transformContext(剪枝 + 注入)
         - 调 convertToLlm(过滤到 LLM-visible 消息)
     7b. 用当前 context 调模型
     7c. 对模型返回的每个事件:
         - text_delta → 追加 assistant/chunk
         - tool_call → 发 PreToolUse hook → 检查 permissions → 执行 → 发 PostToolUse hook
         - tool_result → 追加,继续
     7d. 如果模型发的 tool_calls 违反 read-only → block(PreToolUse 返回 block)
     7e. 流结束?→ 这轮结束
     7f. 还有工作?→ 下一轮

8. bash tool 调用:"git checkout -b refactor/jose-auth"
   - PreToolUse hook 触发:hooks.PreToolUse match=bash 跑 "echo $TOOL_CALL >> audit.log"
   - permission 检查:
     * PermissionMode=read-only
     * bash validators:readOnlyValidation 看到 "git checkout" → 没有 write pattern → allow
   - 执行:git checkout
   - PostToolUse hook 触发

9. write tool 调用:重写 services/auth/src/auth.ts
   - PreToolUse hook 触发
   - permission 检查:
     * PermissionMode=read-only
     * bash validators:readOnlyValidation 看到 write pattern → block,reason="read-only mode cannot write"
   - tool result 返回给模型:"BLOCKED: read-only mode cannot write"
   - 我们走到 ask the user

10. AskForApproval=on-request → 模型说 "I need to switch to workspace-write"
    → UI 提示:"Allow workspace-write mode for this session? [y/n]"
    → 用户同意
    → session config 更新:permission_mode=workspace-write
    → state 继续,没有 session restart

11. write tool 调用现在成功了
    → PreToolUse hook 触发
    → permission 检查:readOnlyValidation 通过(我们现在是 workspace-write)
    → pathValidation:services/auth/src/auth.ts 在 cwd 下 → allow
    → write tool 写文件
    → PostToolUse hook 触发,mtime 记录

12. bash tool 调用:"npm test"
    → 同样流程:permission 检查、validators 通过、执行

13. 轮结束:assistant 发最后总结
    → 追加 assistant/message 到 session log
    → 发 Stop hook
    → state = STOPPED(或者 COMPLETED,看模型怎么想)

14. session 结束
    → 发 SessionEnd hook
    → session log 持久化到 $ENVOY_HOME/sessions/<id>.jsonl
    → cost report:"1.2K prompt + 800 completion tokens, $0.04, 4 turns, 3 tool calls"
```

### 2.3 什么进入 mesh

在这个例子里,**没有任何东西**进入 mesh。Alice 的 session 完全在她自己的节点上跑。envoy-harness 只有在 Alice 跑 `envoy task "..."` 来 spawn sub-agent 时才碰 mesh。这是下一个例子。

### 2.4 Mesh-native sub-agent 例子

Alice 的任务长大了:"also update the gateway to use the new auth client, and check the docs are still right"。她跑:

```
envoy task "search all docs for references to the old jsonwebtoken API; list them"
```

变成:

```
1. envoy task subcommand 解析输入
2. 构造 TaskInput:
   - objective: "search all docs for references to the old jsonwebtoken API; list them"
   - capabilityTag: "code-search"
   - costCeilingUsd: 1.00
   - deadlineMs: 60000
3. mesh/chain-submit.ts:
   - 从 TaskInput 构造 ChainSubtask
   - 用节点的 owner key 签
   - 给 bonded peers 广播 task.propose
4. 另一个节点(Bob 的,跑 OpenClaw)上的 orchestrator 出价
5. orchestrator 接受;chain step 在 Bob 的节点跑
6. Bob 的节点返回 SignedAgentResult
7. envoy-harness 的 Task tool 收到结果
8. 跨 adapter verifier:envoy-harness 自己的规则 + (可选)跨 agent 对比
9. 结果追加到 Alice 的 session
```

**工作跑在不同节点、不同 agent 上,但 verification、cost accounting、audit trail 留在 Alice 的 envoy-harness 节点上。** 这就是 mesh-native sub-agents。

### 2.5 自进化例子(之后)

跑完 50 个这样的 task,envoy-harness 在本地 scoreboard 里有了足够的 verdict。Alice 跑:

```
envoy self-evolve
```

触发 5 步协议:

```
1. SNAPSHOT    — 把当前 verifier-rules.json 拷贝到 /snapshots/v<n>.json
2. HYPOTHESIZE — model:"我看到 8/50 个 bash task false-pass,
                  因为 pathValidation 让 ../ 逃出 cwd。收紧 regex。"
3. CANDIDATE   — 把 candidate ruleset 写到 /candidate/v<n>.json
4. EVALUATE    — 用 candidate 重跑 50 个 task
5. COMMIT      — pass rate 提升了(0.84 → 0.92)→ owner 签 scoreboard entry,
                  把 candidate commit 到 verifier-rules.json
                — 或 REVERT —— pass rate 不变或更差 → 还原 snapshot
```

用户在 `$ENVOY_HOME/agent-state/<peer>/verifier-scoreboard.yaml` 看到一条新 entry,由她的 owner key 签。

---

## 3. Runtime core

这一节描述 *跑起来* 的部分。其他都是这些部分读写的数据。

### 3.1 Agent 类

`Agent` 是长生命周期的 per-node 对象。每个节点一个 Agent。它持有:

- `Models` registry(provider + model 对)
- `ManifestBuilder`(签名并广播 CapabilityManifest)
- `SessionStore`(活跃 Session 实例的内存 map)
- `ReputationBook3Tuple`(本地视图,`(peer, runtime, skillId)` 分数)
- `CostTracker`(per-session 消费累加器)
- `McpClientRegistry`(长生命周期的 MCP client 连接)
- `HookRegistry`(§8 里的 registry)

**Agent 不包含 agent loop。** Agent loop 在 `Session` 里(每个活跃 session 一个)。

```ts
// src/agent.ts(草图)
export class Agent {
  readonly peerId: string
  readonly ownerId: string
  readonly models: Models
  readonly hookRegistry: HookRegistry
  readonly mcpClients: McpClientRegistry
  readonly reputation: ReputationBook3Tuple
  readonly costTracker: CostTracker
  private readonly sessions = new Map<SessionId, Session>()

  constructor(public readonly config: ResolvedConfig) {
    // ... init above
  }

  /**
   * 每个 session 一个。Session 是对话的单位;
   * Agent 是长生命周期的 runtime。
   */
  async createSession(input: CreateSessionInput): Promise<Session> {
    const session = new Session({
      agent: this,
      cwd: input.cwd ?? process.cwd(),
      sandboxPolicy: this.config.sandbox,
      mode: input.mode ?? this.config.permissionMode,
      approval: input.approval ?? this.config.askForApproval,
      agentsMd: input.agentsMd ?? await this.loadAgentsMd(input.cwd),
    })
    this.sessions.set(session.id, session)
    return session
  }

  async resumeSession(id: SessionId): Promise<Session> { /* ... */ }
  async forkSession(id: SessionId, atBoundary: EntryId): Promise<Session> { /* ... */ }

  /**
   * CapabilityManifest 广播。Owner key 签。
   * 按定时器(默认每 150s)和按需运行。
   */
  async broadcastManifest(): Promise<SignedCapabilityManifest> { /* ... */ }
}
```

### 3.2 Session 类

`Session` 是一个 conversation。它有一个状态机(见 §3.3)和一个 agent loop(见 §3.4)。Session 互相独立;一个节点可以有很多活跃 session,每个有自己的 permission mode 和 approval 设置。

```ts
// src/session.ts(草图)
export class Session {
  readonly id: SessionId  // 生成的 UUID
  readonly agent: Agent
  readonly cwd: string
  state: SessionState
  private messages: AgentMessage[]  // 对话
  private readonly hookContext: HookContext

  constructor(public readonly input: SessionInput) {
    this.state = 'loading'
  }

  /**
   * 跑一个 prompt 通过 agent loop。流式 events。
   * 如果 session 在 plan mode,这是只读的。
   */
  async *run(prompt: string | AgentMessage, opts: RunOptions): AsyncIterable<SessionEvent> {
    // ... 见 §3.4
  }

  /**
   * 用户要求 compact。压缩对话历史。
   * 触发 PreCompact 和 PostCompact hooks。
   */
  async compact(): Promise<void> { /* ... */ }

  /**
   * 重读所有 config、hooks、AGENTS.md。不打断当前 turn。
   */
  async reload(): Promise<void> { /* ... */ }

  /**
   * 持久化当前状态。原子写到磁盘。
   */
  async persist(): Promise<void> { /* ... */ }
}
```

### 3.3 Session 状态机

```
                      create
                         │
                         ▼
        ┌────────────── LOADING ──────────────┐
        │ • discover AGENTS.md                  │
        │ • load config                         │
        │ • register hooks                      │
        │ • spawn manifest broadcast            │
                         │
                  session_start fires
                         │
                         ▼
        ┌──────────── ACTIVE ──────────────────┐
        │ • run() 可调                          │
        │ • 用户可交互                           │
        │ • events 流到 UI                       │
        │                                      │
        │  ┌── turn 循环在跑 ──┐                │
        │  │ • model call      │                │
        │  │ • tool calls      │                │
        │  │ • hooks 触发      │                │
        │  └────────────────────┘                │
        │                                      │
        │   on /reload ──────► RELOADING       │
        │   on /compact ────► COMPACTING       │
        │   on cancel ──────► CANCELLING       │
        │   on error ───────► FAILED           │
        │   on completion ───► CLOSING          │
        │                                      │
        └──────────────────────────────────────┘
                         │
                  session_end fires
                         │
                         ▼
        ┌──────────── CLOSED ──────────────────┐
        │ • session log 持久化                  │
        │ • cost report 打印                    │
        │ • hooks 注销                          │
        │ • session 从内存清除                  │
        │ • 可以从磁盘 resume                   │
        └──────────────────────────────────────┘
```

状态穷举:`loading | active | reloading | compacting | cancelling | failed | closing | closed`。**每个转移都触发一个 hook**(`SessionStart`、`Stop`、`SubagentStop`、`SessionEnd` 等),让用户定义的 hook 能响应状态变化。

### 3.4 Agent loop(turn)

turn loop 是 `session.run()` 干的事。它是 agent 的真正"心脏"。

```ts
// src/agent.ts(那个 loop)
async function* runTurn(session: Session, prompt: AgentMessage, opts: RunOptions): AsyncIterable<SessionEvent> {
  // 1. 追加用户消息。
  session.appendMessage(prompt)
  yield { kind: 'user_message_appended', message: prompt }

  // 2. 循环,直到模型不再发 tool call。
  let turnContinues = true
  while (turnContinues) {
    // 2a. 构造 LLM context。
    const contextMessages = session.messages
    const llmMessages = convertToLlm(contextMessages, session.agent.config.llmFilter)

    // 2b. 发 turn_start。
    yield { kind: 'turn_start' }

    // 2c. 如果 context 超预算,触发 PreCompact hook。
    if (estimateContextSize(llmMessages) > session.config.maxContextTokens * 0.8) {
      const decision = await session.hookRegistry.fire('PreCompact', { session, messages: llmMessages })
      if (decision.kind === 'block') {
        yield { kind: 'turn_aborted', reason: 'pre-compact blocked' }
        return
      }
    }

    // 2d. 调模型。
    let assistantMessage: AssistantMessage | null = null
    let toolCalls: ToolCall[] = []
    for await (const event of callModel(llmMessages, session.model, session.signal)) {
      if (event.kind === 'text_delta') {
        yield { kind: 'assistant_text_delta', delta: event.delta }
      } else if (event.kind === 'tool_call') {
        toolCalls.push(event.toolCall)
      } else if (event.kind === 'final') {
        assistantMessage = event.assistantMessage
      }
    }
    if (assistantMessage) session.appendMessage(assistantMessage)
    yield { kind: 'assistant_message', message: assistantMessage }

    // 2e. 如果没有 tool call,这轮结束。
    if (toolCalls.length === 0) {
      turnContinues = false
      break
    }

    // 2f. 执行每个 tool call(v0 串行;并行以后再加)。
    for (const tc of toolCalls) {
      // 触发 PreToolUse hook。Hook 可以 block、修改 input、或 add context。
      const preDecision = await session.hookRegistry.fire('PreToolUse', { tool: tc.name, input: tc.input })
      if (preDecision.kind === 'block') {
        session.appendMessage({ kind: 'tool_result', toolCallId: tc.id, content: 'BLOCKED: ' + preDecision.reason, isError: true })
        yield { kind: 'tool_blocked', toolCall: tc, reason: preDecision.reason }
        continue
      }
      const inputToUse = preDecision.kind === 'modify' ? preDecision.modified : tc.input

      // Permission enforcement(跟 hooks 分开;两个都跑)。
      const permDecision = await session.permissionEnforcer.check(tc.name, inputToUse)
      if (permDecision.kind === 'deny') {
        session.appendMessage({ kind: 'tool_result', toolCallId: tc.id, content: 'DENIED: ' + permDecision.reason, isError: true })
        yield { kind: 'tool_denied', toolCall: tc, reason: permDecision.reason }
        continue
      }
      if (permDecision.kind === 'ask') {
        // AskForApproval=on-request 路径:问用户。
        const userDecision = await session.askUser({ tool: tc.name, input: inputToUse, reason: permDecision.reason })
        if (userDecision.kind === 'deny') {
          session.appendMessage({ kind: 'tool_result', toolCallId: tc.id, content: 'DENIED BY USER', isError: true })
          yield { kind: 'tool_denied_by_user', toolCall: tc }
          continue
        }
      }

      // 执行。
      let result: ToolResult
      try {
        result = await session.executeTool(tc.name, inputToUse, session.signal)
      } catch (err) {
        result = { kind: 'error', content: err.message, isError: true }
      }
      session.appendMessage({ kind: 'tool_result', toolCallId: tc.id, ...result })
      yield { kind: 'tool_result', toolCall: tc, result }

      // 触发 PostToolUse hook(可以改 result)。
      const postDecision = await session.hookRegistry.fire('PostToolUse', { tool: tc.name, input: inputToUse, result })
      if (postDecision.kind === 'modify') {
        // 替换 messages 里的 tool_result。
        session.replaceLastToolResult(postDecision.modified)
      }
    }

    // 2g. 更新 cost tracker。
    session.costTracker.recordTurn({ ... })

    // 2h. 决定是否继续。
    turnContinues = !session.shouldStop()
  }

  // 3. 发 turn_end 和 Stop。
  yield { kind: 'turn_end' }
  await session.hookRegistry.fire('Stop', { session })
}
```

**这就是 runtime。** 这份文档其他每一节描述的都是这个 loop 读写的数据。

**Loop 强制的不变量**:

- 用户消息在模型调用前追加(模型看到它)。
- assistant 消息在模型完成后追加。
- 每个 tool call 在 message log 里有对应的 tool_result。
- Hooks 按正确顺序跑:PreToolUse → permission check → execute → PostToolUse。
- 如果 tool 被 block 或 deny,模型拿到一个 `tool_result` 解释为什么(它能反应)。
- Cost 按 turn 记,不是按 session 结束记。

### 3.5 Tool 执行

每个 tool 有类型化 input schema、execute 函数、已知的 permission 要求。`executeTool` 派发:

```ts
// src/tools/registry.ts(草图)
export interface ToolDefinition<TInput, TOutput> {
  name: string
  description: string
  inputSchema: ZodSchema<TInput>
  outputSchema: ZodSchema<TOutput>
  /** 至少需要的 permission mode。 */
  requires: PermissionMode
  /** 每次调用的 cost(USD)。Read-only tool 是 0。 */
  costUsd: number
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any, any>>()

  register<TI, TO>(tool: ToolDefinition<TI, TO>): void { /* ... */ }

  get(name: string): ToolDefinition<any, any> | undefined { /* ... */ }

  /**
   * 派发。先用 tool 的 schema 验证 input。
   * 返回类型化 output 或类型化 error。
   */
  async dispatch(name: string, input: unknown, ctx: ToolContext): Promise<ToolDispatchResult> {
    const tool = this.tools.get(name)
    if (!tool) return { kind: 'unknown_tool', name }
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) return { kind: 'invalid_input', errors: parsed.error.errors }
    try {
      const output = await tool.execute(parsed.data, ctx)
      return { kind: 'ok', output }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, stack: (err as Error).stack }
    }
  }
}
```

**Tools 永远不在 dispatch 边界抛异常。** 失败的 tool 返回 `{ kind: 'error', ... }`;loop 把它转成 `isError: true` 的 `tool_result`。这是 tool 错误进入对话的唯一方式 —— 模型像看其他结果一样看到文本。

---

## 4. 架构不变量(硬性要求)

每个不变量来自野外的具体失败模式。每个都有具体测试守住。

1. **默认是 read-only。** `SandboxMode::ReadOnly` 是默认。`WorkspaceWrite` 是 per-session opt-in。`DangerFullAccess` 要 owner 私钥签的 escape hatch。**理由**:以"默认能写"发版,会创造不可逆的预期。

2. **Permission 和 approval 是两个独立轴。** `PermissionMode`(3 档:read-only、workspace-write、danger-full-access)控制 *agent 能做什么*;`AskForApproval`(4 档:unless-trusted、on-request、granular、never)控制 *什么时候问用户*。两个组合产生 12 个状态。**理由**:合起来会留洞。

3. **AGENTS.md discovery 是向上 + concat,不是 first-found。** 从 cwd 向上 walk 到最近的带 `project_root_marker`(默认 `.git`)的祖先,收集每个 AGENTS.md。按顺序 concat。在 marker 处停下。**理由**:monorepos 和嵌套项目有多个 AGENTS.md。

4. **`AGENTS.override.md` 是 local override。** 跟 AGENTS.md 一起被发现。用户可以 override 装配好的 doc,不动源文件。**理由**:对团队 AGENTS.md 的修改应该 review,不应该被 local state 静默覆盖。

5. **`project_doc_max_bytes` 预算。** AGENTS.md 总大小的硬上限(默认 32 KB)。**理由**:1MB 的 AGENTS.md 在用户 prompt 读到之前就把 context window 烧完了。

6. **Hooks 是 12 个事件,全有 `pre` / `post` 语义。** PreToolUse、PostToolUse、PreCompact、PostCompact、SessionStart、SessionEnd、Stop、SubagentStop、UserPromptSubmit、Notification、PermissionRequest、Setup。(名字对齐 Codex,便于 mental model 移植。)**理由**:hook 系统 ad-hoc 增长;固定集合可审计。

7. **Bash 有 6 个 validator,不是"用户说 yes = ok"。** `readOnlyValidation`、`destructiveCommandWarning`、`modeValidation`、`sedValidation`、`pathValidation`、`commandSemantics`。**全部 6 个在每次 bash 调用时跑。** 没有任何一个可选。**理由**:bash 是 agent 事故最常见来源;光靠 permission UX 不够。

8. **MCP 是双向的。** envoy-harness 既是 MCP client(消费别人的 server)也是 MCP server(自己的 tools 暴露给其他 MCP client)。**理由**:网络效应 —— 任何 agent 工具的每个用户都成为 envoy-harness 的潜在用户。

9. **Sub-agents 映射到 mesh chain step,不是 in-process task。** Task tool 通过给 mesh orchestrator 提交 chain step 来 spawn sub-agent。Sub-agent 可以跑在本地节点,也可以跑在远程节点。**理由**:mesh-native agent 不该假装 mesh 不存在。

10. **AGENTS.md 和 verifier ruleset 都是自进化的目标。** envoy-harness 在两者上都跑 5 步协议。Optimizer 看 scoreboard + 失败 task 描述;rubric 只 owner 看。**理由**:自进化是 opt-in、owner 控制、peer 可审计。

11. **Tools 永远不在 dispatch 边界抛异常。** 每个 tool 返回 `ToolDispatchResult` 判别联合。Agent loop 把 error 转成 `isError: true` 的 `tool_result`。**理由**:模型 context 里的错误可见,是唯一 work 的错误 UX。

12. **Cost 按 turn 记,不是按 session 结束记。** 每轮在模型调用后立即 increment cost tracker。**理由**:用户应该看到 cost 在涨,不是之后才知道。

13. **Owner keys 给所有跨节点的东西签名。** Manifests、results、verdicts、scoreboard entries、chain steps。Owner key 是 trust anchor。**理由**:签名是跨节点可验证的唯一东西,没有 pre-shared secret。

---

## 5. 类型系统(每个模块说的"语言")

这些是核心类型。全在 `packages/envoy-harness/src/types.ts`。**镜像 Codex 的命名**,因为 parity 本身是 feature —— 从 Codex 迁移的用户期待同样的名字。

### 5.1 Permission 和 approval(两个独立轴)

```ts
import { z } from 'zod'

/**
 * Agent 能做什么。映射到 OS 级能力。3 档,递增权限。
 */
export const PermissionModeSchema = z.enum([
  'read-only',         // 默认。读文件、网络,不能写。
  'workspace-write',   // 在 cwd 内部写(以及显式 writable_roots)。
  'danger-full-access',// 全部写、全部网络。Owner 私钥签的 escape hatch。
])
export type PermissionMode = z.infer<typeof PermissionModeSchema>

/**
 * 什么时候问用户。4 档。
 *
 * `unless-trusted` 是严格模式:只有过 `is_safe_command()` 检查、
 * 只读的命令会自动批准。其他都问。
 *
 * `on-request` 是默认。Model 自己决定什么时候问。
 *
 * `granular` 是结构化替代:per-tool on/off 通过 config。
 *
 * `never` 用于无人值守运行:从不升级,失败关闭。
 */
export const AskForApprovalSchema = z.enum([
  'unless-trusted',
  'on-request',
  'granular',
  'never',
])
export type AskForApproval = z.infer<typeof AskForApprovalSchema>

/**
 * 命名 profile,从 $ENVOY_HOME/<name>.config.toml 加载。
 * 内置 profile: 'read-only'、'workspace-write'、'danger-full-access'。
 * 用户可以 override 任意一个,或加自己的。
 */
export const PermissionProfileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
export type PermissionProfileName = z.infer<typeof PermissionProfileNameSchema>
```

**为什么轴要分开**:用户可能想要 `PermissionMode=read-only` 和 `AskForApproval=never`(不能写的时候问也没用)。或者 `PermissionMode=workspace-write` 和 `AskForApproval=unless-trusted`(只对 known-safe 自动批准)。合起来会强制 3×4=12(或 3)种选择;用户要全部 12 种。

### 5.2 Sandbox

```ts
/**
 * 具体 sandbox 后端。envoy-harness 跟 `linux-landlock`(仅 Linux,OS 级
 * syscall 过滤)和 `process-fs-namespace`(仅 POSIX,mount namespace)。
 * 其他后端是 opt-in。
 */
export const SandboxBackendSchema = z.enum([
  'linux-landlock',
  'process-fs-namespace',
  'none',  // 仅 PermissionMode=DangerFullAccess
])
export type SandboxBackend = z.infer<typeof SandboxBackendSchema>

/**
 * 组合的 sandbox policy。Session 启动时从 PermissionMode +
 * AskForApproval + SandboxBackend + writable_roots 解析。
 */
export interface SandboxPolicy {
  mode: PermissionMode
  approval: AskForApproval
  backend: SandboxBackend
  /** workspace-write 模式下可写的路径。空 = 只 cwd。 */
  writableRoots: ReadonlyArray<string>
  /** 如果 true,workspace-write 模式下允许网络。 */
  networkAccess: boolean
  /** 如果 true,/tmp 也可写(默认 true)。 */
  excludeSlashTmp: boolean
}
```

### 5.3 Bash validators(6 个 submodule 名)

```ts
/**
 * 每个 validator 是 (command, argv, env, policy) -> Verdict 的函数。
 * 按顺序跑;任何 Verdict::fail 短路。
 */
export interface BashValidator {
  readonly name: string
  validate(input: BashValidationInput): Promise<BashVerdict>
}

export type BashVerdict =
  | { kind: 'allow' }
  | { kind: 'allow-with-warning', warning: string }  // 继续,但显示 warning
  | { kind: 'block', reason: string }
```

6 个 validator(名字来自 `claw-code/PARITY.md:67`):

1. `readOnlyValidation` —— read-only 模式但命令要写。Block。
2. `destructiveCommandWarning` —— `rm -rf /`、`dd if=...` 等。Allow with warning 或 block。
3. `modeValidation` —— 当前 mode vs 命令要求。
4. `sedValidation` —— `sed -i` 在系统文件上原地编辑。Block。
5. `pathValidation` —— 命令碰 writable_roots 外的路径。Block。
6. `commandSemantics` —— 语法正确,没 shell injection pattern。

**这是 bash 的安全脊柱。** 全部 6 个在每次 bash 调用时跑。**没有任何一个可选。** 6 个的组合是安全故事,不是任一个。

### 5.4 Hook 事件(12 个名字)

```ts
export const HookEventNameSchema = z.enum([
  'PreToolUse',         // tool call 之前
  'PostToolUse',        // tool call 之后
  'PreCompact',         // 上下文压缩之前
  'PostCompact',        // 上下文压缩之后
  'SessionStart',       // session 开始
  'SessionEnd',         // session 结束
  'Stop',               // 主 agent 停止(用户可以干预)
  'SubagentStop',       // sub-agent 停止
  'UserPromptSubmit',   // 用户提交消息
  'Notification',       // permission 请求、空闲超时等
  'PermissionRequest',  // 需要 permission 决策
  'Setup',              // 初始 setup hooks(只跑一次)
])
export type HookEventName = z.infer<typeof HookEventNameSchema>

/**
 * Hook handler。可以是 shell command(字符串)或 TS module(path)。
 * 每个事件多个 handler 按注册顺序跑。
 */
export interface HookHandler {
  match?: { tool?: string; pattern?: string }  // 按 tool 名或 pattern 过滤
  command?: string                              // shell command,$TOOL_CALL 被插值
  module?: string                               // TS module path,export default HookFn
  timeoutMs?: number
}

export type HookFn = (event: HookEvent) => Promise<HookDecision>

export type HookDecision =
  | { kind: 'continue' }
  | { kind: 'modify', modified: unknown }  // 仅 PostToolUse
  | { kind: 'block', reason: string }       // PreToolUse / PermissionRequest
  | { kind: 'add-context', content: string } // SessionStart / PreCompact
```

### 5.5 AGENTS.md

```ts
export const AGENTS_MD_FILENAME = 'AGENTS.md'
export const AGENTS_OVERRIDE_FILENAME = 'AGENTS.override.md'

/**
 * 一个发现的 AGENTS.md。可能来自 user、project、或 local override。
 */
export interface DiscoveredAgentsDoc {
  /** 绝对路径。 */
  path: string
  /** 文件内容。 */
  contents: string
  /** Origin: 'user' (~/...)、'project' (cwd-relative)、或 'override' (local)。 */
  origin: 'user' | 'project' | 'override'
  /** 字节数;用于预算检查。 */
  byteLength: number
}

/**
 * 完整装配好的集合,按 concat 顺序。顺序是:
 *   1. user instructions(从 settings 或 env)
 *   2. project docs(cwd 向上,每个 AGENTS.md)
 *   3. project override(AGENTS.override.md,冲突时优先)
 *
 * 用 separator concat。镜像 codex-rs/core/src/agents_md.rs:43。
 */
export interface LoadedAgentsMd {
  entries: ReadonlyArray<DiscoveredAgentsDoc>
  totalBytes: number
  /** 已 concat,准备好注入系统 prompt。 */
  assembled: string
}

export const DEFAULT_PROJECT_ROOT_MARKERS = ['.git']
export const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024  // 32 KB
```

### 5.6 Verdict(verifier 的结果)

`Verdict` 和 friends 在 MAP 协议里(`packages/protocol/src/agent-adapter.ts`)。这里重新内联一份完整版:

```ts
export const VerdictSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pass'),
    score: z.number().min(0).max(1),
    confidence: z.enum(['low', 'medium', 'high']).default('medium'),
    notes: z.string().optional(),
  }),
  z.object({
    kind: z.literal('partial'),
    score: z.number().min(0).max(1),
    reason: z.string(),
    usableBlocks: z.array(z.number().int().nonnegative()).optional(),
  }),
  z.object({
    kind: z.literal('fail'),
    reason: z.string(),
    rollback: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('disputed'),
    needsHuman: z.literal(true),
    signals: z.array(z.string()),
  }),
])
export type Verdict = z.infer<typeof VerdictSchema>

export const VerifierSourceSchema = z.enum(['rule', 'llm', 'human', 'cross'])
export type VerifierSource = z.infer<typeof VerifierSourceSchema>

export const VerdictEntrySchema = z.object({
  chainId: z.string(),
  subtaskId: z.string(),
  workerPeerId: z.string(),
  workerRuntime: AgentRuntimeSchema,
  skillId: SkillIdSchema,
  verdict: VerdictSchema,
  source: VerifierSourceSchema,
  verifierModel: z.string().optional(),
  verifierOwnerId: z.string().optional(),
  issuedBy: z.string(),
  issuedAt: z.string().datetime(),
  signature: z.string(),
})
export type VerdictEntry = z.infer<typeof VerdictEntrySchema>
```

envoy-harness 实现 `VerifierSource: 'rule'` 做便宜检查;`'llm'` 用 verifier LLM(owner 配置的、便宜 model);`'cross'` 做跨 adapter 一致性。`'human'` 保留给用户升级时用。

### 5.7 Sub-agent(mesh-native)

```ts
/**
 * Task tool 的输入。被 envoy-harness 翻译成 chain step
 * 提交给 mesh orchestrator。
 */
export interface TaskInput {
  /** sub-task 的 plain-language 描述。 */
  objective: string
  /** 需要的 capability。映射到 MeshAdapter Manifest。 */
  capabilityTag: string
  /** Cost ceiling(USD)。映射到 ChainBudgetLedger.reserve。 */
  costCeilingUsd: number
  /** Deadline(ms)。映射到 chain orchestrator 的 timeout。 */
  deadlineMs: number
  /** 可选:钉到特定 peer(否则 orchestrator 选)。 */
  preferredPeerId?: string
  /** 可选:钉到特定 runtime(否则任意)。 */
  preferredRuntime?: AgentRuntime
}

/**
 * Task 完成时本地 agent 收到的东西。
 * 跟远端 AgentResult 同形,只是本地的。
 */
export interface TaskResult {
  taskId: TaskId
  status: 'completed' | 'failed' | 'partial' | 'disputed'
  content: ContentBlock[]
  verdict: Verdict
  costUsd: number
  durationMs: number
  workerPeerId: string
  workerRuntime: AgentRuntime
}
```

---

## 6. Permission 系统

### 6.1 两个轴,完整

3 × 4 = 12 种状态:

| | `unless-trusted` | `on-request` | `granular` | `never` |
|---|---|---|---|---|
| `read-only` | 只放 known-safe 读。其他都问。| Model 决定;只读命令跑。| Per-tool config。| 跑任何 read-only 内的;不提示。|
| `workspace-write` | 放 known-safe;问 write+network。| Model 决定;cwd-write OK;问非 cwd。| Per-tool config。| 跑任何 workspace-write 内的;不提示。|
| `danger-full-access` | (实际上 `never`,因为 cap 没了)| Model 决定;唯一真正的安全检查是用户提示。| Per-tool config。| 跑任何;不提示。**Owner 私钥签。**|

12 个 cell 不是"12 个不同产品"。它们是同一 permission + approval engine 上的 12 个 *默认*。代码一样;config 不同。

### 6.2 6 个 bash validator(真实实现)

```ts
// src/permissions/bash/read-only.ts
import type { BashValidator, BashValidationInput } from './index.js'
import type { BashVerdict } from './index.js'

/**
 * 如果 policy 是 read-only 但命令要写,block。
 * 检测:`>`、`>>`、`tee`、`sed -i`、`mv`、`cp`、`rm`、`touch`、`mkdir`、`chmod` 中的任意。
 *
 * 这不是 parser。是启发式。6 个这样的启发式的组合是安全故事,
 * 不是任一个。
 */
export const readOnlyValidation: BashValidator = {
  name: 'read-only',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (input.policy.mode !== 'read-only') return { kind: 'allow' }
    const writePattern = />>?|tee |sed -i|\bmv\b|\bcp\b|\brm\b|\btouch\b|\bmkdir\b|\bchmod\b/i
    if (writePattern.test(input.command)) {
      return { kind: 'block', reason: 'read-only mode cannot write' }
    }
    return { kind: 'allow' }
  },
}
```

```ts
// src/permissions/bash/destructive-warning.ts
export const destructiveCommandWarning: BashValidator = {
  name: 'destructive-warning',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (/rm\s+(-[a-z]*f[a-z]*\s+)?\/(\s|$)|dd\s+if=.*\s+of=\/dev/i.test(input.command)) {
      return { kind: 'allow-with-warning', warning: 'destructive: targets root or device' }
    }
    return { kind: 'allow' }
  },
}
```

```ts
// src/permissions/bash/mode.ts
export const modeValidation: BashValidator = {
  name: 'mode',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    // 非网络模式下的网络访问:block。
    if (!input.policy.networkAccess && /\bcurl\b|\bwget\b|\bnc\b|\bssh\b|\bnslookup\b/.test(input.command)) {
      return { kind: 'block', reason: 'network disabled in this mode' }
    }
    return { kind: 'allow' }
  },
}
```

```ts
// src/permissions/bash/sed.ts
export const sedValidation: BashValidator = {
  name: 'sed',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    // sed -i 在系统文件上是常见灾难。
    if (/sed\s+-i/.test(input.command)) {
      const systemPath = /\/etc\/|\/usr\/|\/var\/|\/bin\/|\/sbin\//.test(input.command)
      if (systemPath) {
        return { kind: 'block', reason: 'sed -i on system path blocked' }
      }
    }
    return { kind: 'allow' }
  },
}
```

```ts
// src/permissions/bash/path.ts
import * as path from 'node:path'

export const pathValidation: BashValidator = {
  name: 'path',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (input.policy.mode !== 'workspace-write') return { kind: 'allow' }
    const roots = input.policy.writableRoots.length > 0
      ? input.policy.writableRoots
      : [input.cwd]
    for (const arg of input.argv) {
      if (arg.startsWith('/') || arg.startsWith('~')) {
        const resolved = path.resolve(input.cwd, arg)
        if (!roots.some(root => resolved.startsWith(root))) {
          return { kind: 'block', reason: `path ${arg} is outside writable_roots` }
        }
      }
    }
    return { kind: 'allow' }
  },
}
```

```ts
// src/permissions/bash/semantics.ts
export const commandSemanticsValidation: BashValidator = {
  name: 'command-semantics',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    // 检测常见的 shell injection pattern:不平衡的引号、反引号等。
    if (hasUnbalancedQuotes(input.command)) {
      return { kind: 'block', reason: 'unbalanced quotes' }
    }
    if (containsBackticks(input.command)) {
      return { kind: 'block', reason: 'backticks not allowed' }
    }
    return { kind: 'allow' }
  },
}
```

**组合**(`src/permissions/bash/index.ts`):

```ts
export const ALL_VALIDATORS: ReadonlyArray<BashValidator> = [
  readOnlyValidation,
  modeValidation,
  sedValidation,
  pathValidation,
  destructiveCommandWarning,
  commandSemanticsValidation,
]

export async function validateBash(input: BashValidationInput): Promise<BashVerdict> {
  // 第一遍:任何 block 短路。
  for (const v of ALL_VALIDATORS) {
    const verdict = await v.validate(input)
    if (verdict.kind === 'block') return verdict
  }
  // 第二遍:surface 最严重的 warning(如果有)。
  for (const v of ALL_VALIDATORS) {
    const verdict = await v.validate(input)
    if (verdict.kind === 'allow-with-warning') return verdict
  }
  return { kind: 'allow' }
}
```

**这 6 个 validator 的测试是一条 parity**(`parity/01-bash-validation.toml`)。

### 6.3 PermissionEnforcer

```ts
// src/permissions/enforce.ts(草图)
export type EnforcementResult =
  | { kind: 'allowed' }
  | { kind: 'denied', tool: string, mode: PermissionMode, reason: string }
  | { kind: 'ask', tool: string, reason: string }

export class PermissionEnforcer {
  constructor(
    private readonly policy: ResolvedPolicy,
    private readonly askUser: (q: AskUserQuestion) => Promise<AskUserAnswer>,
  ) {}

  async check(toolName: string, input: unknown): Promise<EnforcementResult> {
    const tool = this.toolRegistry.get(toolName)
    if (!tool) return { kind: 'denied', tool: toolName, mode: this.policy.mode, reason: 'unknown tool' }

    // 1. Permission mode:这个 tool 在这个 mode 下根本被允许吗?
    if (this.policy.mode === 'read-only' && tool.requires !== 'read-only') {
      return { kind: 'denied', tool: toolName, mode: 'read-only', reason: `requires ${tool.requires}` }
    }

    // 2. 对 bash,跑 6 个 validator。
    if (toolName === 'bash') {
      const verdict = await validateBash({ command: input.command, argv: input.argv, env: input.env, policy: this.policy, cwd: this.cwd })
      if (verdict.kind === 'block') return { kind: 'denied', tool: toolName, mode: this.policy.mode, reason: verdict.reason }
      if (verdict.kind === 'allow-with-warning') {
        // 通过 UI surface warning;不 deny。
        await this.ui.notify(verdict.warning, 'warning')
      }
    }

    // 3. Approval:用户需要被问吗?
    if (this.policy.approval === 'never') return { kind: 'allowed' }
    if (this.policy.approval === 'unless-trusted' && tool.isSafe && tool.requires === 'read-only') {
      return { kind: 'allowed' }
    }
    if (this.policy.approval === 'on-request' && tool.requires === 'read-only' && tool.isSafe) {
      return { kind: 'allowed' }
    }
    return { kind: 'ask', tool: toolName, reason: this.reasonFor(tool, input) }
  }

  private async handleAsk(tool: string, input: unknown, reason: string): Promise<EnforcementResult> {
    const answer = await this.askUser({ prompt: `Allow ${tool}?`, reason, options: ['allow', 'deny', 'allow-always-this-session'] })
    if (answer.kind === 'allow-always-this-session') {
      this.sessionAllowed.add(tool)
      return { kind: 'allowed' }
    }
    return answer
  }
}
```

**关键不变量**:当 tool 被 deny 或 block,模型拿到一个 `isError: true` 的 `tool_result` 解释为什么。模型能反应 —— 比如换更安全的命令,或者停。**错误是可见的。**

---

## 7. Sandbox 系统

### 7.1 3 个后端

| Backend | 平台 | 机制 | 默认? |
|---|---|---|---|
| `linux-landlock` | Linux | Kernel 级 filesystem + network syscall 过滤 | Linux 默认 |
| `process-fs-namespace` | macOS, Linux(回退)| Mount namespace + chroot | macOS 默认,Linux 回退 |
| `none` | 全部 | 没有 sandbox;靠 permissions | 只在 `PermissionMode=danger-full-access` 下 |

### 7.2 解析算法

```
1. 读 config:permission_mode、sandbox_backend
2. 如果 sandbox_backend == "auto":
   - 如果 Linux → linux-landlock
   - 如果 macOS → process-fs-namespace
   - 如果 Windows → none(响亮地警告)
3. 如果 permission_mode == "danger-full-access":
   - sandbox_backend 必须是 "none"
4. 初始化 backend。
5. 应用 policy:writable_roots、network_access、exclude_slash_tmp。
6. Probe:确保 backend 真的能 enforce(比如 landlock 可用、namespace 能建)。
   - 如果 probe 失败:降级到更安全的 backend;如果没有更安全的,拒绝启动。
```

### 7.3 Landlock 后端(草图)

```ts
// src/sandbox/backend-linux-landlock.ts
export class LandlockBackend implements SandboxBackend {
  async applyPolicy(policy: SandboxPolicy, cwd: string): Promise<void> {
    // 从 policy 构造 ruleset。
    const ruleset: LandlockRuleset = await createRuleset()
    if (policy.mode === 'read-only') {
      // 允许所有路径的读。
      ruleset.addRule(landlock.AccessFS.readFile, '/')
      ruleset.addRule(landlock.AccessFS.readDir, '/')
    } else if (policy.mode === 'workspace-write') {
      // 允许所有地方的读。
      ruleset.addRule(landlock.AccessFS.readFile, '/')
      ruleset.addRule(landlock.AccessFS.readDir, '/')
      // 只允许 writable_roots 和 /tmp(如果 exclude_slash_tmp)的写。
      for (const root of policy.writableRoots.length > 0 ? policy.writableRoots : [cwd]) {
        ruleset.addRule(landlock.AccessFS.writeFile, root)
        ruleset.addRule(landlock.AccessFS.removeFile, root)
        ruleset.addRule(landlock.AccessFS.makeReg, root)
        ruleset.addRule(landlock.AccessFS.makeDir, root)
      }
      if (policy.excludeSlashTmp) {
        ruleset.addRule(landlock.AccessFS.writeFile, '/tmp')
        ruleset.addRule(landlock.AccessFS.removeFile, '/tmp')
        ruleset.addRule(landlock.AccessFS.makeReg, '/tmp')
        ruleset.addRule(landlock.AccessFS.makeDir, '/tmp')
      }
    } else {
      // danger-full-access:不限制 ruleset。
      return
    }
    // 通过 prctl(PR_SET_NO_NEW_PRIVS) + seccomp + landlock 应用。
    await prctlSetNoNewPrivs()
    await seccompSetNoNewPrivs()
    await ruleset.apply()
  }
}
```

其他后端同形:从 `SandboxPolicy` 构造 ruleset,应用。

---

## 8. Hook 系统

Hook 系统是**用户的扩展面**。他们在 `hooks.toml` 里加一条 `[[hook.PreToolUse]]`,shell command 或 TS module 在合适的时机跑。

### 8.1 12 个事件(完整)

| 事件 | 什么时候 | Handler 能做什么 |
|---|---|---|
| `SessionStart` | Session 加载完,第一轮前 | `add-context` 把指令注入系统 prompt |
| `UserPromptSubmit` | 用户提交消息 | `block`(不处理)、`add-context` |
| `PreToolUse` | tool call 之前 | `block`(不跑 tool)、`modify`(改 input)|
| `PostToolUse` | tool call 之后 | `modify`(在结果到模型前改)|
| `PreCompact` | 上下文压缩之前 | `add-context`(注入必须活下来的东西)|
| `PostCompact` | 上下文压缩之后 | (主要是 logging)|
| `Stop` | 主 agent 停止 | (用户可以干预;用新 prompt resume)|
| `SubagentStop` | sub-agent 停止 | (logging)|
| `Notification` | permission 提示、空闲超时等 | (UI;handlers 通常只 log)|
| `PermissionRequest` | 需要 permission 决策 | `block`(直接 deny)、`modify`(提供答案)|
| `Setup` | 安装时一次 | (一次性 setup:建目录、注册 MCP 等)|

### 8.2 Registry(真实)

```ts
// src/hooks/registry.ts
export class HookRegistry {
  private handlers = new Map<HookEventName, HookHandler[]>()
  private middlewares: Array<(eventName: HookEventName, payload: unknown) => Promise<HookDecision>> = []

  /** 注册一个 handler。 */
  on(eventName: HookEventName, handler: HookHandler): void {
    const existing = this.handlers.get(eventName) ?? []
    existing.push(handler)
    this.handlers.set(eventName, existing)
  }

  /** 加一个 middleware(在 handlers 前跑;可以短路)。 */
  use(middleware: (eventName: HookEventName, payload: unknown) => Promise<HookDecision>): void {
    this.middlewares.push(middleware)
  }

  /**
   * 触发事件。返回组合的 decision。
   *   - 第一个 `block` 胜出。
   *   - 否则,最后一个 `modify` 胜出(仅 PostToolUse)。
   *   - 否则,所有 `add-context` 被 concat。
   *   - 否则,`continue`。
   */
  async fire(eventName: HookEventName, payload: unknown): Promise<HookDecision> {
    // Middlewares 先。它们可以短路。
    for (const middleware of this.middlewares) {
      const decision = await middleware(eventName, payload)
      if (decision.kind === 'block') return decision
    }

    const handlers = this.handlers.get(eventName) ?? []
    const matched = handlers.filter(h => this.matchHandler(h, payload))

    let lastModify: HookDecision | null = null
    const contexts: string[] = []

    for (const handler of matched) {
      const decision = await this.runHandler(handler, eventName, payload)
      if (decision.kind === 'block') return decision
      if (decision.kind === 'modify' && eventName === 'PostToolUse') {
        lastModify = decision
      }
      if (decision.kind === 'add-context') {
        contexts.push(decision.content)
      }
    }
    if (contexts.length > 0) {
      return { kind: 'add-context', content: contexts.join('\n\n') }
    }
    if (lastModify) return lastModify
    return { kind: 'continue' }
  }

  private matchHandler(handler: HookHandler, payload: unknown): boolean {
    if (!handler.match) return true
    if (handler.match.tool && (payload as { tool?: string }).tool !== handler.match.tool) {
      return false
    }
    if (handler.match.pattern) {
      const re = new RegExp(handler.match.pattern)
      if (!re.test(JSON.stringify(payload))) return false
    }
    return true
  }

  private async runHandler(handler: HookHandler, eventName: HookEventName, payload: unknown): Promise<HookDecision> {
    if (handler.command) {
      return await runShellHandler(handler.command, eventName, payload, handler.timeoutMs ?? 5000)
    }
    if (handler.module) {
      const mod = await import(handler.module)
      return await mod.default({ eventName, payload })
    }
    return { kind: 'continue' }
  }
}
```

### 8.3 Shell handler(真实)

```ts
// src/hooks/runner.ts
import { spawn } from 'node:child_process'

export async function runShellHandler(
  command: string,
  eventName: HookEventName,
  payload: unknown,
  timeoutMs: number,
): Promise<HookDecision> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      env: {
        ...process.env,
        HOOK_EVENT: eventName,
        HOOK_PAYLOAD: JSON.stringify(payload),
        TOOL_CALL: JSON.stringify(payload),  // 旧 alias
        RESULT_FILE: '',  // PostToolUse 填
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout!.on('data', d => stdout += d.toString())
    child.stderr!.on('data', d => stderr += d.toString())
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({ kind: 'block', reason: `hook timed out after ${timeoutMs}ms` })
        return
      }
      if (code !== 0) {
        // 非零退出:当 block 处理,surface stderr。
        resolve({ kind: 'block', reason: `hook exited ${code}: ${stderr.slice(0, 200)}` })
        return
      }
      // 解析 stdout。JSON 形状: { decision, content, modified, reason }
      try {
        const parsed = JSON.parse(stdout)
        if (parsed.decision === 'block') {
          resolve({ kind: 'block', reason: parsed.reason ?? 'blocked by hook' })
        } else if (parsed.decision === 'add-context') {
          resolve({ kind: 'add-context', content: parsed.content })
        } else {
          resolve({ kind: 'continue' })
        }
      } catch {
        // 非 JSON stdout:把 stdout 当 add-context。
        if (stdout.trim().length > 0) {
          resolve({ kind: 'add-context', content: stdout })
        } else {
          resolve({ kind: 'continue' })
        }
      }
    })
  })
}
```

**Hook handlers 受 bash tool 的 permission 系统约束。** 一个跑 `rm -rf /` 的 hook 在 read-only 模式下会被 `readOnlyValidation` 抓住。**Hooks 不是后门;它们是同一个信任模型的一部分。**

### 8.4 Hook loader

```ts
// src/hooks/loader.ts
export async function loadHooksFromToml(path: string): Promise<HookRegistry> {
  const text = await fs.readFile(path, 'utf8')
  const parsed = Toml.parse(text) as Record<string, unknown>
  const registry = new HookRegistry()
  for (const [eventName, handlers] of Object.entries(parsed)) {
    if (!isHookEventName(eventName)) continue
    if (!Array.isArray(handlers)) continue
    for (const h of handlers) {
      if (typeof h === 'object' && h !== null) {
        registry.on(eventName, h as HookHandler)
      }
    }
  }
  return registry
}
```

---

## 9. AGENTS.md discovery(照搬 Codex)

`src/agents-md/discover.ts`:

```ts
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const AGENTS_MD_FILENAME = 'AGENTS.md'
const AGENTS_OVERRIDE_FILENAME = 'AGENTS.override.md'
const SEPARATOR = '\n\n--- project-doc ---\n\n'

export interface DiscoveredDoc {
  path: string
  contents: string
  origin: 'user' | 'project' | 'override'
  byteLength: number
}

export interface DiscoveryOptions {
  cwd: string
  projectRootMarkers: ReadonlyArray<string>  // default ['.git']
  fallbackFilenames: ReadonlyArray<string>   // default []
  maxBytes: number                            // default 32 KB
}

export interface DiscoveryResult {
  entries: ReadonlyArray<DiscoveredDoc>
  totalBytes: number
  assembled: string
}

/**
 * 从 cwd 向上 walk 到最近的带 project_root_marker 的祖先,
 * 收集每个 AGENTS.md(以及 fallback filenames)。
 *
 * 镜像 codex-rs/core/src/agents_md.rs:1-90,逐行。
 */
export async function discoverAgentsMd(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const { cwd, projectRootMarkers, fallbackFilenames, maxBytes } = opts

  // 1. 向上 walk 找 project root。
  const projectRoot = await findProjectRoot(cwd, projectRootMarkers)

  // 2. 收集 projectRoot 到 cwd(含)每个 AGENTS.md。
  const paths = await collectDocPaths({
    fromDir: projectRoot,
    toDir: cwd,
    filenames: [AGENTS_MD_FILENAME, ...fallbackFilenames],
  })

  // 3. 读每个,尊守 maxBytes 预算。
  const entries: DiscoveredDoc[] = []
  let totalBytes = 0
  for (const p of paths) {
    if (totalBytes >= maxBytes) break
    try {
      const contents = await fs.readFile(p, 'utf8')
      const remaining = maxBytes - totalBytes
      const trimmed = contents.length > remaining
        ? contents.slice(0, remaining)
        : contents
      entries.push({
        path: p,
        contents: trimmed,
        origin: 'project',
        byteLength: Buffer.byteLength(trimmed, 'utf8'),
      })
      totalBytes += Buffer.byteLength(trimmed, 'utf8')
    } catch (err) {
      // 文件不存在 OK;权限错误 log 后继续。
      console.warn(`failed to read ${p}: ${err.message}`)
    }
  }

  // 4. 读 override(如果存在)(放最后,所以它胜出)。
  const overridePath = path.join(cwd, AGENTS_OVERRIDE_FILENAME)
  try {
    const contents = await fs.readFile(overridePath, 'utf8')
    const remaining = maxBytes - totalBytes
    if (remaining > 0) {
      const trimmed = contents.length > remaining
        ? contents.slice(0, remaining)
        : contents
      entries.push({
        path: overridePath,
        contents: trimmed,
        origin: 'override',
        byteLength: Buffer.byteLength(trimmed, 'utf8'),
      })
      totalBytes += Buffer.byteLength(trimmed, 'utf8')
    }
  } catch { /* 没有 override,OK */ }

  // 5. 装配。每个 doc 前面带一个 HTML 注释,标明 origin 和 path,
  //    模型知道每段从哪来的。
  const assembled = entries
    .map(e => `<!-- origin: ${e.origin} path: ${e.path} -->\n${e.contents}`)
    .join(SEPARATOR)

  return { entries, totalBytes, assembled }
}

async function findProjectRoot(cwd: string, markers: ReadonlyArray<string>): Promise<string> {
  if (markers.length === 0) return cwd
  let dir = path.resolve(cwd)
  const visited = new Set<string>()
  while (!visited.has(dir)) {
    visited.add(dir)
    for (const marker of markers) {
      try {
        await fs.access(path.join(dir, marker))
        return dir  // 找到了
      } catch { /* 这里没有 */ }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return cwd  // 到文件系统根
    dir = parent
  }
  return cwd
}

async function collectDocPaths(input: {
  fromDir: string
  toDir: string
  filenames: ReadonlyArray<string>
}): Promise<string[]> {
  const { fromDir, toDir, filenames } = input
  const out: string[] = []
  let dir = path.resolve(toDir)
  const stop = path.resolve(fromDir)
  while (true) {
    for (const filename of filenames) {
      const p = path.join(dir, filename)
      out.push(p)
    }
    if (dir === stop) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out.reverse()  // root 到 cwd 顺序
}
```

**这是 canonical 模式。** 不要重新发明;从 Codex 抄。`codex-rs/core/src/agents_md_tests.rs` 里的测试是它的 parity 测试。

---

## 10. Tools

Tools 是类型化的;agent loop 从不调原始函数。每个 tool 有 input schema、output schema、permission 要求、cost。

### 10.1 内置 tools(v0)

| 名字 | 用途 | 需要 | Cost USD |
|---|---|---|---|
| `read` | 读文件内容 | `read-only` | 0 |
| `write` | 写文件(覆盖或创建)| `workspace-write` | 0.001 |
| `edit` | 应用定向编辑(apply_patch)| `workspace-write` | 0.002 |
| `bash` | 跑 shell 命令 | `read-only`(默认;validators 可能加限制)| 可变 |
| `git` | git 操作:status、diff、commit、push、branch、PR | `workspace-write` | 0 |
| `mcp__*` | MCP tools(动态注册)| per-tool | per-tool |

> **注意:`task` tool 在 envoy-harness 的 `tools/` 里 *没有*。** Task tool 需要 mesh 连接;它住在 Package 3(`@envoymesh/envoy-harness-adapter`)的 `chain-submit.ts` 里。envoy-harness 本身是 mesh-agnostic。

### 10.2 git tool(自动 branch/commit/PR)

```ts
// src/tools/git.ts(草图)
export const gitTool: ToolDefinition<GitInput, GitOutput> = {
  name: 'git',
  description: 'Git operations: status, diff, commit, branch, push, PR creation.',
  inputSchema: GitInputSchema,
  outputSchema: GitOutputSchema,
  requires: 'workspace-write',
  costUsd: 0,
  async execute(input, ctx) {
    switch (input.op) {
      case 'status': return runGit(['status', '--porcelain'], ctx.cwd)
      case 'diff': return runGit(['diff', input.ref ?? 'HEAD'], ctx.cwd)
      case 'commit': {
        // 如果在 main 上,自动建 branch。
        const currentBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.cwd)
        if (currentBranch === 'main' || currentBranch === 'master') {
          const newBranch = `envoy/${ctx.sessionId}-${Date.now()}`
          await runGit(['checkout', '-b', newBranch], ctx.cwd)
        }
        return runGit(['commit', '-m', input.message, '--author', `envoy-harness <envoy@${ctx.ownerId}>`], ctx.cwd)
      }
      case 'push': {
        return runGit(['push', '-u', 'origin', 'HEAD'], ctx.cwd)
      }
      case 'pr': {
        // 用 gh CLI(如果可用);否则清晰报错。
        return runGh(['pr', 'create', '--title', input.title, '--body', input.body ?? ''], ctx.cwd)
      }
    }
  },
}
```

**Auto-branch** 是杀手级特性:agent commit 时从不意外落到 `main`(或用户任何受保护的 branch)。branch 命名为 `envoy/<sessionId>-<timestamp>`,用户能轻松找到并 squash。

### 10.3 Task tool(mesh-native sub-agent)

> **Status:shipped in Phase 5(F10.1–F10.6)。** `MeshSubmitter` seam + `LocalMeshSubmitter`(Package 1) + `RemoteMeshSubmitter`(Package 3) 替换了本节原本包含的 pre-Phase-5 sketch。v0 ship 了 `LocalMeshSubmitter`;`RemoteMeshSubmitter` 是一个 1 行的 wrapper,盖在 opaque `RemoteSubmitterTransport` 上(crypto、wire format、parent request 签名、worker result 验证都住在 transport 里,不在 adapter 里)。Routing(`RoutingHint`)和 result 签名(`SubagentResultSigner`)由 host 注入。完整分层见 [`docs/boundary.en.md`](./boundary.en.md),实现记录见 [`docs/implementation-plan.md`](./implementation-plan.md) §3 / §6.6。
>
> **代码位置:**
> - Types + default factory:`packages/envoy-harness/src/subagent/{types,local-mesh-submitter,signer,fan-out,tools,index}.ts`
> - Remote submitter:`packages/envoy-harness-adapter/src/remote-mesh-submitter.ts`

**"真能跑"的 sub-agent,by design。**

`task` tool 是父 agent 的 escape hatch:当 model 决定 "this needs a different perspective" 或 "I need a specialist",它调 tool;tool 把请求提交给 `MeshSubmitter`;submitter 执行(或路由)sub-agent,返回结果。按设计不变式 #9("Sub-agents 映射到 mesh chain step,不是 in-process task")。

| Aspect | envoy-harness 设计 | Codex/Claude Code |
|---|---|---|
| Lifetime | 新 session(自己的 id、AGENTS.md、hooks、permission) | 进程内 fork |
| Permission | **Worker 自己的 policy**,不是 requester 的 | 继承 parent |
| Discoverability | `capabilityTag`(orchestrator 路由) | 硬编码 pattern |
| Audit | Sub-agent 的 `SignedAgentResult` 引用在 parent 的 transcript 里 | 一个 transcript |
| Cost | Parent 付(per `chain-budget-ledger`);sub-agent 上报自己的 cost | Parent 付;没有干净的归属 |
| Trust | 密码学 —— worker 的 owner key 给 result 签名 | 信 fork |

**为什么 v0 只 local:** `MeshSubmitter` interface 就是 seam。v0 ship `LocalMeshSubmitter`,它在 NEW local session 里跑 sub-agent。Interface 本身支持 remote submitter(未来的 `RemoteMeshSubmitter`,会调 EnvoyMesh orchestrator);v0 不 ship。Host 可以换实现而不改 `task` tool。

**为什么是 new session 而不是 in-place fork:** 即使是 local 执行,sub-agent 也拿到自己的:

- session id(audit trail 区分 parent 和 sub-agent 的 transcript)
- AGENTS.md(sub-agent 看到的 workspace 视角可能不同 —— 比如不同的 `cwd`)
- hook context(PreToolUse / PostToolUse 各自触发;parent 的 hook 不作用于 sub-agent 的 tool call)
- permission mode(sub-agent 的 `read-only` vs `workspace-write` 是 WORKER 的 policy,不是 requester 的)

这就是 "sub-agents 映射到 mesh chain step" 不变式最纯粹的形式:sub-agent 是一个全新的 session,就这样。

**Type surface**(load-bearing 形态 —— 见 `packages/envoy-harness/src/subagent/types.ts`):

```ts
/** sub-agent 的输入:一个 objective、一个 routing hint、
 *  一个 cost ceiling、一个 deadline。*/
export interface SubagentInput {
  objective: string;
  /** orchestrator(或 local router)用来选
   *  runtime + tools 的 free-form tag。*/
  capabilityTag: string;
  costCeilingUsd: number;
  deadlineMs: number;
  /** 可选:优先某个 peer(mesh routing hint)。
   *  v0 的 LocalMeshSubmitter 忽略它。*/
  preferredPeerId?: string;
  /** 可选:优先某个 runtime。v0 的
   *  LocalMeshSubmitter 忽略它。*/
  preferredRuntime?: AgentRuntime;
}

/** sub-agent 跑完的 result:content 流、verdict、
 *  cost、duration,以及(跨节点时)密码学签名。*/
export interface SubagentResult {
  status: 'completed' | 'failed' | 'partial';
  content: ReadonlyArray<ContentBlock>;
  workerPeerId: string;
  workerRuntime: AgentRuntime;
  costUsd: number;
  durationMs: number;
  /** v0:总是 6 个 default verdict 之一。
   *  未来:mesh orchestrator 的 verdict。*/
  verdict: Verdict;
  /** v0:空字符串(local;不需要密码学信任)。
   *  未来:result 上的 Ed25519。*/
  signature: string;
}

/** `task` tool 和实际 sub-agent 执行之间的 seam。*/
export interface MeshSubmitter {
  submit(input: SubagentInput, signal: AbortSignal):
    Promise<SubagentResult>;
}

/** submit 时直接抛的 MeshSubmitter。
 *  AgentOptions.meshSubmitter 为 undefined 时的默认值。
 *  失败大声比静默 no-op 强。*/
export class NoopMeshSubmitter implements MeshSubmitter {
  async submit(): Promise<SubagentResult> {
    throw new Error(
      'task tool called but no MeshSubmitter is configured. ' +
      'Set AgentOptions.meshSubmitter to a LocalMeshSubmitter ' +
      '(or a future RemoteMeshSubmitter).'
    );
  }
}
```

**Local submitter**(v0 "真能跑"的路径;见 `src/subagent/local-mesh-submitter.ts`):

```ts
export class LocalMeshSubmitter implements MeshSubmitter {
  constructor(private readonly opts: {
    /** 工厂:为 sub-agent 构造一个全新的 Agent。
     *  每次调用返回 NEW Agent + NEW session。*/
    buildSubagent: (input: SubagentInput) => Agent;
    /** 本节点的 peerId。盖在 result 上。*/
    workerPeerId: string;
    /** 可选:host 提供的 result signer。
     *  设置后,result 在返回前会被签名。*/
    signer?: (result: SubagentResult) => string;
  }) {}

  async submit(input, signal): Promise<SubagentResult> {
    const agent = this.opts.buildSubagent(input);
    const startedAt = Date.now();
    const result = await agent.run(input.objective, { signal });
    const subResult: SubagentResult = {
      status: result.stopReason === 'aborted' ? 'failed' : 'completed',
      content: result.content,
      workerPeerId: this.opts.workerPeerId,
      workerRuntime: 'envoy-harness',
      costUsd: result.metrics.costUsd,
      durationMs: Date.now() - startedAt,
      verdict: synthesizeVerdict(result),
      signature: '',  // local;不需要信任
    };
    return this.opts.signer
      ? { ...subResult, signature: this.opts.signer(subResult) }
      : subResult;
  }
}
```

Sub-agent 的 permission 是 **它自己节点**的 policy,不是请求者的。请求者在 `read-only` 可以 spawn 一个 `workspace-write` 的 sub-agent;cost 是请求者付(per `chain-budget-ledger`),但动作是在 worker 节点上、用 worker 的 policy 执行的。

---

## 11. Reference MAP adapter

> **这个代码在哪儿**:整个 §11 描述 `src/mesh/adapter.ts` 在 **`@envoymesh/envoy-harness-adapter`(Package 3)** 里,**不**在 `@envoymesh/envoy-harness`(Package 1)里。envoy-harness **没有** `mesh/` 目录。Adapter 是知道两边的薄桥;envoy-harness 保持 mesh-agnostic。见 §1.3 的 repository 策略。
>
> 下面展示的 `EnvoyHarnessAdapter` 类是 `AgentAdapter` 的 **reference** 实现。其他 mesh 平台(比如假设的 "XMesh")可以按同样的模式做它们自己的集成。

`src/mesh/adapter.ts` —— 把 envoy-harness 变成 first-class MAP adapter 的实现。

```ts
import type {
  AgentAdapter,
  CapabilityManifest,
  SignedAgentResult,
  Verdict,
  VerdictEntry,
  AgentRuntime,
  SkillDescriptor,
  ContentBlock,
  AgentResult,
} from '@envoymesh/protocol'
import { signCanonicalPayload } from '@envoymesh/identity'

export const ENVOY_HARNESS_VERSION = '0.0.0'

/**
 * envoy-harness 广播的 skill 目录。每个 skill 映射到本地 agent 里
 * 一个已知的 tool 组合。
 */
export const ENVOY_HARNESS_SKILLS: ReadonlyArray<SkillDescriptor> = [
  { skillId: 'code-edit',  description: 'Read, edit, and write code in a project.', costCeilingUsd: 5.00, maxSensitivity: 'private', tags: ['code', 'edit'] },
  { skillId: 'code-review', description: 'Review a diff for correctness and style.',     costCeilingUsd: 3.00, maxSensitivity: 'private', tags: ['code', 'review'] },
  { skillId: 'doc-search',  description: 'Search docs and notes for a query.',          costCeilingUsd: 1.00, maxSensitivity: 'friends', tags: ['doc', 'search'] },
  { skillId: 'bash-run',    description: 'Run a constrained bash command on the worker.', costCeilingUsd: 0.50, maxSensitivity: 'friends', tags: ['bash', 'shell'] },
  { skillId: 'plan',        description: 'Read-only planning and exploration.',         costCeilingUsd: 1.00, maxSensitivity: 'friends', tags: ['plan'] },
]

export class EnvoyHarnessAdapter implements AgentAdapter {
  readonly runtime: AgentRuntime = 'envoy-harness'

  constructor(
    private readonly peerId: string,
    private readonly ownerId: string,
    private readonly ownerPrivateKey: CryptoKey,
    private readonly localRunner: LocalRunner,  // 见 §11.1
  ) {}

  describeSkills(): SkillDescriptor[] {
    return [...ENVOY_HARNESS_SKILLS]
  }

  /**
   * 为广播构造签过名的 manifest。Owner 签。
   */
  async buildManifest(input: { reputationBySkill: Record<string, number> }): Promise<CapabilityManifest> {
    const unsigned: CapabilityManifest = {
      runtime: this.runtime,
      runtimeVersion: ENVOY_HARNESS_VERSION,
      peerId: this.peerId,
      ownerId: this.ownerId,
      skills: this.describeSkills(),
      reputationBySkill: input.reputationBySkill,
      issuedAt: new Date().toISOString(),
      ttlSeconds: 300,
    }
    return signCanonicalPayload(unsigned, this.ownerPrivateKey)
  }

  /**
   * 在本地 envoy-harness runtime 上跑 skill。
   * 没有 HTTP、没有 CLI、没有翻译。直接调用。
   */
  async execute(input: SkillExecutionInput): Promise<SignedAgentResult> {
    const result = await this.localRunner.run({
      skillId: input.skillId,
      objective: input.objective,
      inputArtifacts: input.inputArtifacts,
      costCeilingUsd: input.costCeilingUsd,
      deadlineMs: input.deadlineMs,
      signal: input.signal,
    })
    return signCanonicalPayload(result, this.ownerPrivateKey)
  }

  /**
   * envoy-harness 的 verifier 是最完整的:6 个 rule-based 检查,
   * 加 verifier LLM(配了的话)加跨 agent 一致性(worker 跑在
   * 别的 runtime 时)。其他 adapter 从子集开始,慢慢加。
   */
  async verify(input: { result: SignedAgentResult; objective: string }): Promise<Verdict[]> {
    const verdicts: Verdict[] = []
    for (const rule of ALL_VERIFIER_RULES) {
      const v = await rule.check(input.result, input.objective)
      if (v !== null) verdicts.push(v)
    }
    return verdicts
  }
}
```

### 11.1 LocalRunner

`LocalRunner` 是从 MAP adapter 到本地 envoy-harness session 的桥。它在本地节点开一个 *新* session(让 sub-agent 有自己的 AGENTS.md、hooks、permission state),跑 skill,返回结果。

```ts
// 在 adapter package 里:src/mesh/local-runner.ts(草图)
export class LocalRunner {
  constructor(private readonly agent: Agent) {}

  async run(input: LocalRunnerInput): Promise<AgentResult> {
    // 1. 用自己的 permission state 创建一个 sub-session。
    //    重要:sub-session 继承父的 settings 但获得
    //    新的 AGENTS.md 和新的 hook context。
    const subSession = await this.agent.createSession({
      mode: this.deriveModeFromCostCeiling(input.costCeilingUsd),
      approval: 'never',  // sub-agent 无人值守跑;mesh orchestrator 已经批了
      agentsMd: undefined,  // 重新发现(从 worker 的 cwd,不是请求者的)
    })

    // 2. 构造 system prompt。
    const systemPrompt = buildSystemPrompt({
      skillId: input.skillId,
      objective: input.objective,
      agentsMd: subSession.agentsMd,
    })

    // 3. 跑 turn 循环。
    let finalContent: ContentBlock[] = []
    let costUsd = 0
    let promptTokens = 0
    let completionTokens = 0
    const start = Date.now()
    for await (const event of subSession.run([userText(input.objective)], {
      signal: input.signal,
      systemPrompt,
    })) {
      if (event.kind === 'assistant_text_delta') {
        // 累加 text 给最后的 text block。
      } else if (event.kind === 'tool_result') {
        // Tools 在这里被允许。Sub-session 有自己的 permission state。
      } else if (event.kind === 'assistant_message') {
        finalContent = [...finalContent, { kind: 'text', text: event.message.text, mimeType: 'text/markdown' }]
      } else if (event.kind === 'turn_end') {
        costUsd = subSession.costTracker.totalUsd
        promptTokens = subSession.costTracker.promptTokens
        completionTokens = subSession.costTracker.completionTokens
      }
    }
    const end = Date.now()

    // 4. 关闭 sub-session。
    await subSession.close()

    // 5. 构造 AgentResult。
    return {
      skillId: input.skillId,
      runtime: 'envoy-harness',
      peerId: this.agent.peerId,
      correlationId: input.correlationId,
      content: finalContent,
      citations: [],
      metrics: { durationMs: end - start, promptTokens, completionTokens, costUsd },
      completedAt: new Date().toISOString(),
    }
  }
}
```

**为什么是 sub-session,不是 sub-task?** 因为每个 skill 应该有自己的 AGENTS.md(worker 的 cwd 跟请求者的不同)、自己的 permission state(请求者可能在 read-only,但 worker 可能需要写)、自己的 hook context。**Session 是隔离的单位。**

---

## 12. Verifier

Verifier 检查 result 是否真的回答了 objective。本地 rule engine 快且免费;LLM verifier 是升级路径。

### 12.1 6 个 rule-based 检查

```ts
// src/verifier/rules/output-matches-objective.ts
export const outputMatchesObjective: VerifierRule = {
  name: 'output-matches-objective',
  async check(result: AgentResult, objective: string): Promise<Verdict | null> {
    const text = concatText(result.content)
    if (text.length === 0) {
      return { kind: 'fail', reason: 'empty output' }
    }
    // 一个便宜的启发式:text 里包含 objective 的至少一个 keyword 吗?
    const keywords = extractKeywords(objective)
    const matched = keywords.filter(kw => text.toLowerCase().includes(kw.toLowerCase()))
    if (matched.length < keywords.length * 0.5) {
      return { kind: 'partial', reason: `output matches ${matched.length}/${keywords.length} keywords` }
    }
    return { kind: 'pass', score: matched.length / keywords.length, confidence: 'low' }
  },
}
```

其他 5 个 rule 同形:

- `non-empty-content` —— 至少一个 text/structured block。
- `sandbox-respected` —— content 不包含 worker policy 之外的路径。
- `approval-respected` —— content 不暗示 worker 做了 mandate 禁止的事。
- `task-shape` —— `result.content` 是 valid `ContentBlock[]` per schema。
- `cost-reasonable-for-work` —— `metrics.costUsd` 在这个 skill 的合理范围内。

**Rule 集作为一个 JSON 文件发出来**在 `$ENVOY_HOME/agent-state/<peer>/verifier-rules.json`。5 步协议编辑这个文件(见 §13)。

### 12.2 Composite verifier

```ts
// src/verifier/composite.ts
export async function runVerifierRules(
  result: AgentResult,
  objective: string,
  ruleSet: ReadonlyArray<VerifierRule>,
): Promise<Verdict[]> {
  const verdicts: Verdict[] = []
  for (const rule of ruleSet) {
    const v = await rule.check(result, objective)
    if (v !== null) verdicts.push(v)
  }
  return verdicts
}

export function combineVerdicts(verdicts: Verdict[]): Verdict {
  if (verdicts.some(v => v.kind === 'fail')) {
    return verdicts.find(v => v.kind === 'fail')!
  }
  if (verdicts.length === 0) {
    return { kind: 'disputed', needsHuman: true, signals: ['verifier produced no verdicts'] }
  }
  if (verdicts.every(v => v.kind === 'pass')) {
    const scores = verdicts.filter(v => v.kind === 'pass').map(v => v.score)
    return {
      kind: 'pass',
      score: scores.reduce((a, b) => a + b, 0) / scores.length,
      confidence: scores.length >= 3 ? 'high' : 'medium',
    }
  }
  // 有些 pass 有些 partial:降级到 partial。
  return { kind: 'partial', score: 0.5, reason: 'verifier disagreement' }
}
```

### 12.3 LLM source(升级)

```ts
// src/verifier/source-llm.ts
export async function llmSource(input: {
  result: AgentResult
  objective: string
  model: Model
  prompt: string  // 可配置
}): Promise<Verdict> {
  const userPrompt = `You are verifying a worker agent's output.

OBJECTIVE (what the user asked for):
${input.objective}

WORKER OUTPUT:
${serializeAgentResult(input.result)}

Decide:
- pass: the output addresses the objective
- partial: the output partially addresses the objective
- fail: the output does not address the objective

Respond with a JSON object: { kind, score, reason }.
`
  const response = await callModel(input.model, [
    { role: 'system', content: input.prompt },
    { role: 'user', content: userPrompt },
  ])
  return parseVerdictFromLlm(response)
}
```

LLM verifier 用 **比 worker 更便宜的 model**(比如 worker 用 `claude-opus-4`,verifier 用 `claude-haiku`)。直觉:worker 是贵的那个;verifier 检查 worker 的声称,所以它应该便宜。

### 12.4 4-source 级联

```
1. 永远跑全部 6 个 rule。组合。
2. 如果组合 verdict 是 'pass':完成。记录 VerdictEntry。
3. 如果 'fail':完成。记录。(orchestrator 可能回滚 cost reserve。)
4. 如果 'partial' 或 'disputed':跑 LLM source。跟 rule verdicts 组合。
5. 如果还是 'partial' 或 'disputed':升级到 human(Notification hook 触发)。
6. 如果 chain 有 criticality='high':也跑 cross-source(用不同 model
   平行跑同一个 envoy-harness task 对比)。
```

**这是 `harness-design/design.md` §10 里的 verifier 银弹,在 envoy-harness 上的具体化。**

---

## 13. 自进化(5 步协议)

`src/agents-md/self-evolve.ts` —— Penguin 风格 5 步协议的 runtime,作用在用户的 AGENTS.md 和 verifier ruleset 上。

### 13.1 协议,带代码

```ts
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const ScoreboardEntrySchema = z.object({
  version: z.number().int().positive(),
  hypothesis: z.string(),
  rulesetHash: z.string(),
  meanScore: z.number().min(0).max(1),
  passRateBefore: z.number().min(0).max(1),
  passRateAfter: z.number().min(0).max(1),
  nRuns: z.number().int().nonnegative(),
  status: z.enum(['kept', 'reverted']),
  ownerSignature: z.string(),
  createdAt: z.string().datetime(),
})
type ScoreboardEntry = z.infer<typeof ScoreboardEntrySchema>

export class SelfEvolve {
  constructor(
    private readonly paths: {
      scoreboard: string   // ~/.envoymesh/agent-state/<peer>/verifier-scoreboard.yaml
      snapshotDir: string   // ~/.envoymesh/agent-state/<peer>/snapshots/
      benchmark: string    // ~/.envoymesh/agent-state/<peer>/benchmarks/<name>/frozen.yaml
      ruleset: string      // ~/.envoymesh/agent-state/<peer>/verifier-rules.json
      agentsMd: string      // ~/.envoymesh/agent-state/<peer>/AGENTS.md
    },
    private readonly ownerKey: CryptoKey,
    private readonly model: Model,
  ) {}

  /**
   * 跑一轮 5 步协议。
   */
  async runOneCycle(): Promise<{ kept: boolean; entry: ScoreboardEntry }> {
    // 1. SNAPSHOT —— 拷贝当前状态。
    const version = (await this.latestVersion()) + 1
    const snapshot = path.join(this.paths.snapshotDir, `v${version}.tar.gz`)
    await this.snapshot(snapshot)

    // 2. HYPOTHESIZE —— model 提出具体变更。
    const hypothesis = await this.proposeHypothesis()
    if (!hypothesis) {
      // 没有可操作的假设;记录并退出。
      return { kept: false, entry: await this.recordEntry(version, { hypothesis: 'no actionable hypothesis', status: 'reverted', /* ... */ }) }
    }

    // 3. CANDIDATE —— 应用变更到 candidate。
    const candidate = await this.applyCandidate(hypothesis)
    const candidatePath = path.join(this.paths.snapshotDir, `v${version}.candidate.json`)
    await fs.writeFile(candidatePath, JSON.stringify(candidate, null, 2))

    // 4. EVALUATE —— 在 candidate 上跑 benchmark。
    const before = await this.scoreboardBaseline()
    const after = await this.runBenchmark(candidate, this.paths.benchmark)

    // 5. COMMIT/REVERT —— 严格更高的 pass rate 才保留。
    const kept = after.passRate > before.passRate
    const entry: ScoreboardEntry = {
      version,
      hypothesis: hypothesis.text,
      rulesetHash: hash(candidate),
      meanScore: after.meanScore,
      passRateBefore: before.passRate,
      passRateAfter: after.passRate,
      nRuns: after.nRuns,
      status: kept ? 'kept' : 'reverted',
      ownerSignature: await signCanonicalPayload({ version, hypothesis: hypothesis.text, after }, this.ownerKey),
      createdAt: new Date().toISOString(),
    }
    await this.recordEntry(version, entry)
    if (kept) {
      await this.commitCandidate(candidate)
    } else {
      // 已经 snapshot 了;没有要 undo 的。
    }
    return { kept, entry }
  }

  private async proposeHypothesis(): Promise<{ text: string; ruleChanges: VerifierRule[]; agentsMdChanges?: string } | null> {
    // 从 scoreboard 最近的失败构造 prompt。
    const recent = await this.recentFailures(20)
    const prompt = `You are the self-evolution optimizer for envoy-harness.

The recent 20 task failures (from scoreboard) are:
${JSON.stringify(recent, null, 2)}

Propose ONE specific, falsifiable change to the verifier ruleset that would
catch more of these failures. Be conservative: small, targeted changes only.

Output JSON: { hypothesis: string, ruleChanges: VerifierRule[] }
`
    const response = await callModel(this.model, [{ role: 'user', content: prompt }])
    return parseHypothesisFromLlm(response)
  }

  private async runBenchmark(candidate: VerifierRuleset, benchmarkPath: string): Promise<BenchmarkResult> {
    // 加载 frozen benchmark。对每个 case,用 candidate 跑。
    const benchmark = await loadBenchmark(benchmarkPath)
    const results: Array<{ pass: boolean }> = []
    for (const task of benchmark.tasks) {
      const result = await this.runOneWithRuleset(task, candidate)
      results.push({ pass: result.verdict.kind === 'pass' })
    }
    const passRate = results.filter(r => r.pass).length / results.length
    return { passRate, meanScore: passRate, nRuns: results.length, tasks: results }
  }

  private async recordEntry(version: number, partial: Partial<ScoreboardEntry>): Promise<ScoreboardEntry> {
    const entry: ScoreboardEntry = {
      version,
      hypothesis: partial.hypothesis ?? 'unknown',
      rulesetHash: partial.rulesetHash ?? 'unknown',
      meanScore: partial.meanScore ?? 0,
      passRateBefore: partial.passRateBefore ?? 0,
      passRateAfter: partial.passRateAfter ?? 0,
      nRuns: partial.nRuns ?? 0,
      status: partial.status ?? 'reverted',
      ownerSignature: await signCanonicalPayload(partial, this.ownerKey),
      createdAt: new Date().toISOString(),
    }
    // 追加到 scoreboard.yaml(原子写)。
    const existing = await this.readScoreboard()
    existing.push(entry)
    await fs.writeFile(this.paths.scoreboard, serializeYaml(existing))
    return entry
  }
}
```

### 13.2 污染防护

Optimizer **永远看不到**:
- Rubric(私有评测标准)
- Gold answers

Optimizer **可以看到**:
- Scoreboard 最近的失败(只是描述,没 gold)
- 当前 ruleset
- 它正在提的 candidate ruleset

这跟 Penguin 用的 guard 一样(`agent-optimization/SKILL.md` 明确"do not inspect Rubrics, Gold answers, private scoring conditions")。**在 envoy-harness 里,guard 是 API 强制**:`proposeHypothesis` 函数的 prompt 装配不包含 rubric 或 gold 文件;只有 scoreboard entries 和当前 ruleset。

### 13.3 联邦 scoreboard

跑 envoy-harness 的 peer 可以 opt-in 进**联邦 scoreboard**:拉其他 envoy-harness peer 在类似 task 上验证过的 rules。

```ts
// src/scoreboard/mesh.ts(草图)  -- 也可能在 adapter package 里
export class FederatedScoreboard {
  async pull(optIn: boolean): Promise<void> {
    if (!optIn) return
    // 1. 向 bonded peers 查询它们的公开 scoreboard。
    const peerScoreboards = await this.broadcastAndCollect({ kind: 'federated_pull_request' })
    // 2. 对每个 candidate rule,通过本地 5 步协议跑它。
    for (const entry of peerScoreboards.flatMap(p => p.entries)) {
      if (entry.status !== 'kept') continue
      const local = await this.localSelfEvolve.runOneCycleAgainst({
        hypothesis: entry.hypothesis,
        ruleChanges: entry.ruleChanges,
      })
      if (local.kept) {
        // 采用了。
        await this.recordFederatedAdoption(entry)
      }
    }
  }
}
```

**Pull 是 opt-in,绝不是 push。** Peer 永远不会自动收到 rules;operator 必须 opt-in,并且本地 5 步协议是最后的关。

---

## 14. Cost tracking

Cost 按 **per turn 记,不是 per session 结束记**。

```ts
// src/cost/tracker.ts
export class CostTracker {
  private promptTokens = 0
  private completionTokens = 0
  private costByProvider = new Map<string, number>()
  private readonly costCeilingUsd: number
  private readonly warnAtUsd: number

  constructor(opts: { costCeilingUsd: number; warnAtUsd: number }) {
    this.costCeilingUsd = opts.costCeilingUsd
    this.warnAtUsd = opts.warnAtUsd
  }

  /**
   * 记录一次模型调用。返回调用是否被允许。
   */
  recordModelCall(call: { promptTokens: number; completionTokens: number; costUsd: number; provider: string }): { allowed: boolean; reason?: string } {
    this.promptTokens += call.promptTokens
    this.completionTokens += call.completionTokens
    this.costByProvider.set(call.provider, (this.costByProvider.get(call.provider) ?? 0) + call.costUsd)
    if (this.totalUsd >= this.costCeilingUsd) {
      return { allowed: false, reason: `cost ceiling ${this.costCeilingUsd} exceeded` }
    }
    if (this.totalUsd >= this.warnAtUsd) {
      // Surface 到 UI 但不停。
    }
    return { allowed: true }
  }

  get totalUsd(): number {
    let sum = 0
    for (const v of this.costByProvider.values()) sum += v
    return sum
  }

  report(): CostReport {
    return {
      totalUsd: this.totalUsd,
      byProvider: Object.fromEntries(this.costByProvider),
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
    }
  }
}
```

**用户看到 cost 在涨。** 每个 turn 之后,UI 显示"spent $0.42 of $5.00 cap"。如果一次模型调用会推过 cap,调用被拒绝,模型拿到 `isError: true` 的 `tool_result`("cost ceiling exceeded"),用户被问是否延长 cap 或结束 session。

### 14.1 执行前 cost 估计

对长跑 task,用户想在 agent 开始**之前**看到 cost 估计。Estimator 看 task 的复杂度(objective 长度、AGENTS.md 大小、类似过去 task 的历史),给一个区间:

```ts
// src/cost/estimator.ts(草图)
export async function estimateCost(input: {
  objective: string
  agentsMdSize: number
  historyMean: number  // 类似过去 task 的 mean cost
}): Promise<{ min: number; max: number; mean: number }> {
  const base = input.historyMean * 1.2  // 20% buffer
  const sizeAdjustment = Math.log2(input.agentsMdSize / 4096 + 1) * 0.05
  return { min: base * 0.5, max: base * 2.0, mean: base + sizeAdjustment }
}
```

这是启发式,不是保证。实际 cost 可能超过 max。**Estimator 是设预期,不是 hard limit**(那是 cap)。

---

## 15. Sub-agent 协议(mesh-native 的流程)

> **Status:shipped in Phase 5。** 下面是设计层的 narrative;真正的代码路径在 `src/subagent/local-mesh-submitter.ts`(Package 1)做本地执行,`packages/envoy-harness-adapter/src/remote-mesh-submitter.ts`(Package 3)做 mesh 路由执行。**单条规则**(见 [`docs/boundary.en.md`](./boundary.en.md)):routing 是 mesh 的事;envoy-harness 暴露 `MeshSubmitter` seam + `RoutingHint`,target 由 mesh 决定。

当 `envoy task` 被调用,以下端到端发生:

```
ALICE 的节点(envoy-harness)
─────────────────────────────────────────────────
1. CLI 解析 "envoy task ..."
2. Task tool 的 execute() 被调用。
3. 构造 ChainSubtask,用 owner key 签。
4. mesh/chain-submit.ts 给 bonded peers 广播 task.propose。

           ┌──── 广播:task.propose ────┐
           │                                    │
           ▼                                    ▼
   BOB 的节点                          CAROL 的节点
   (OpenClaw)                          (Pi)
   ────────────                        ─────
5a. 收到 proposal。                     5b. 收到 proposal。
6a. Bob 的 orchestrator 评估            6b. Carol 的 orchestrator 评估
    Alice 的 reputation +                 Alice 的 reputation + capability。
    capability 匹配。                     
7a. Bob 出价:                           7b. Carol 出价:
    "我能做 code-search,                  "我能做 code-search,
     我出 $0.30"                          我出 $0.45"
8. Alice 的 orchestrator 选 Bob         (Carol 输了)
    (更便宜 + 同样的 reputation)。

9. Bob 的 worker 通过 OpenClawAdapter 执行 subtask。
10. OpenClawAdapter 的 verifier 跑(只 rule-based —— Bob 的 OpenClaw
    还没有 LLM verifier)。
11. Bob 产生 SignedAgentResult,用 Bob 的 owner key 签。
12. Bob 的 orchestrator 把结果返回给 Alice。

ALICE 的节点(envoy-harness,继续)
─────────────────────────────────────────────────
13. Task tool 的 execute() 收到结果。
14. MAP adapter 的 verify() 跑:
    - 6 个 rule-based 检查(envoy-harness 是最完整的)
    - 可选地,如果 task 是 criticality='high',跨 agent 验证
      (Alice 的 envoy-harness 也跑同一个 task 并对比)
15. Verdict 作为 VerdictEntry 记录在 ArbitrationStore。
16. Cost 记录在 chain-budget-ledger.ts。
17. TaskResult 返回给 agent loop。
18. 模型在 tool_result 里看到 sub-agent 的结果。
19. Turn 继续(模型可能根据结果跑更多 tool call)。
```

**关键观察**:

- 请求者付 cost(Alice 的节点)。
- Worker 干活(Bob 的节点)。
- Verification 是请求者的责任(Alice 的 envoy-harness 有最完整的 verifier)。
- 跨 agent 对比是 opt-in(只在关键 task 上)。

---

## 16. Observability

每个 turn 产生一串 `SessionEvent`。用户可以在 TUI、`--json` 输出,或者 web UI(未来)里看到。

### 16.1 事件类型

```ts
export type SessionEvent = DiscriminatedUnion<{
  'session_start': { config: ResolvedConfig, agentsMdBytes: number }
  'session_end': { durationMs: number, costReport: CostReport, totalTurns: number }
  'turn_start': { turnIndex: number }
  'user_message': { text: string }
  'assistant_text_delta': { delta: string }
  'assistant_message': { content: string, toolCalls: ToolCall[] }
  'tool_call': { name: string, input: unknown }
  'tool_result': { name: string, result: unknown, isError: boolean, durationMs: number }
  'tool_blocked': { name: string, reason: string, by: 'hook' | 'permission' }
  'tool_denied': { name: string, reason: string, by: 'user' }
  'hook_fired': { event: HookEventName, handlerCount: number, decision: HookDecision }
  'permission_asked': { name: string, reason: string, answer: 'allow' | 'deny' | 'allow-session' }
  'cost_update': { spentUsd: number, ceilingUsd: number, warning?: string }
  'verifier_fired': { source: VerifierSource, verdict: Verdict, durationMs: number }
  'turn_end': { turnIndex: number, costUsd: number }
  'stop': { reason: 'completed' | 'user_stop' | 'cost_ceiling' | 'error' }
}>
```

### 16.2 JSON Lines 输出

```
$ envoy "summarize src/foo.ts" --json | tee session.jsonl
{"kind":"session_start","config":{...},"agentsMdBytes":1024}
{"kind":"user_message","text":"summarize src/foo.ts"}
{"kind":"turn_start","turnIndex":0}
{"kind":"assistant_text_delta","delta":"I'll read the file first."}
{"kind":"tool_call","name":"read","input":{"path":"src/foo.ts"}}
{"kind":"hook_fired","event":"PreToolUse","handlerCount":2,"decision":{"kind":"continue"}}
{"kind":"tool_result","name":"read","result":{...},"isError":false,"durationMs":12}
{"kind":"assistant_text_delta","delta":"\n\nSummary: ..."}
{"kind":"turn_end","turnIndex":0,"costUsd":0.012}
{"kind":"stop","reason":"completed"}
{"kind":"session_end","durationMs":8432,"costReport":{...},"totalTurns":1}
```

这种格式 `jq`、trace UI、replay 工具都能消费。

### 16.3 Session log(持久)

`$ENVOY_HOME/sessions/<sessionId>.jsonl` —— 只追加,每行一个 event。Session 崩溃后可以通过读 log resume。**这是"model-visible means logged"不变量:模型看到的任何东西都能从 log 重建。**

---

## 17. 错误处理

### 17.1 TaggedError

从 Pi 借(`pi/packages/agent/src/harness/agent-harness.ts:28-55`):

```ts
// src/errors/tagged-error.ts
export class TaggedError<T extends string, D extends object> extends Error {
  readonly _tag: T
  readonly data: D
  constructor(tag: T, data: D) {
    super(data.message as string ?? tag)
    this._tag = tag
    this.data = data
    this.name = tag
  }
}

export function tagged<T extends string, D extends object>(tag: T) {
  return class extends TaggedError<T, D> {
    constructor(data: D) { super(tag, data) }
  }
}
```

用法:

```ts
export class LaneBusy extends tagged('LaneBusy')<{
  lane: string
  operationId: string
  message: string
}>() {}

export class BashBlocked extends tagged('BashBlocked')<{
  command: string
  validator: string
  reason: string
  message: string
}>() {}
```

### 17.2 错误传播规则

1. **Tools 永远不在 dispatch 边界抛异常。** 它们返回 `{ kind: 'error', ... }`。Agent loop 转成 `isError: true` 的 `tool_result`。
2. **Hooks 可以抛(timeout、非零退出)。** Hook runner 抓住并转成 `{ kind: 'block', reason: ... }`。
3. **Verifiers 可以抛。** Composite 抓住并当 `disputed` 处理。
4. **Sandbox init 可以抛。** 抓住并 surface 给用户,清晰地说"无法启动 sandbox;回退到 mode X"或"中止 session"。
5. **Model calls 可以抛。** 当作 `turn_end` 带 `stop: { reason: 'error' }`;用户可以重试。

**原则:每条错误路径都是类型化且可见的。** `BashBlocked` 错误告诉用户 *哪个 validator 拦了哪个命令*;不是 "command failed" 字符串。

---

## 18. 文件和模块布局

下面的布局展示 **Package 1: `@envoymesh/envoy-harness`**。Package 2(`@envoymesh/protocol`)和 Package 3(`@envoymesh/envoy-harness-adapter`)列在本节末尾。见 §1.3 了解 repository 策略。

```
packages/envoy-harness/                    # npm 上的 @envoymesh/envoy-harness
├── package.json                              # name: "@envoymesh/envoy-harness"
│                                            # deps: 来自 EnvoyMesh monorepo 的依赖都没有(per §1.3.1)
├── tsconfig.json
├── README.md                                 # "envoy-harness is the reference CLI agent"
├── src/
│   ├── index.ts                              # public API exports
│   ├── types.ts                              # §5 的 schemas 和 types
│   ├── agent.ts                              # Agent 类(lifecycle, long-lived)
│   ├── session.ts                            # Session(状态机, agent loop)
│   ├── cli.ts                                # CLI entry, flag 解析
│   ├── slash-cmds.ts                         # /help, /compact, /reload, /status
│   ├── output/
│   │   ├── stream-json.ts                    # JSON Lines 流式
│   │   ├── human.ts                          # pretty terminal
│   │   └── compact.ts                        # 上下文压缩
│   ├── permissions/
│   │   ├── mode.ts                           # PermissionMode 解析
│   │   ├── approval.ts                       # AskForApproval + UI 提示
│   │   ├── profile.ts                        # 从 $ENVOY_HOME 加载 profile
│   │   ├── enforce.ts                        # PermissionEnforcer(loop 的 check)
│   │   └── bash/
│   │       ├── index.ts                     # 6 个 validator 的组合
│   │       ├── read-only.ts
│   │       ├── destructive-warning.ts
│   │       ├── mode.ts
│   │       ├── sed.ts
│   │       ├── path.ts
│   │       └── semantics.ts
│   ├── sandbox/
│   │   ├── policy.ts                         # SandboxPolicy 解析
│   │   ├── backend-linux-landlock.ts
│   │   ├── backend-process-namespace.ts
│   │   └── backend-none.ts
│   ├── hooks/
│   │   ├── registry.ts                       # 12 个 hook event 类型
│   │   ├── loader.ts                         # 从 $ENVOY_HOME/hooks.toml 加载
│   │   ├── runner.ts                         # 执行 handlers(shell 或 module)
│   │   └── events/                           # per-event payload shape
│   │       ├── pre-tool-use.ts
│   │       ├── post-tool-use.ts
│   │       ├── pre-compact.ts
│   │       ├── post-compact.ts
│   │       ├── session-start.ts
│   │       ├── session-end.ts
│   │       ├── stop.ts
│   │       ├── subagent-stop.ts
│   │       ├── user-prompt-submit.ts
│   │       ├── notification.ts
│   │       ├── permission-request.ts
│   │       └── setup.ts
│   ├── agents-md/
│   │   ├── discover.ts                       # 从 cwd 向上 walk, concat(verbatim Codex)
│   │   ├── assemble.ts                       # 构造 LoadedAgentsMd
│   │   └── self-evolve.ts                    # 5 步协议
│   ├── tools/
│   │   ├── registry.ts                       # tool dispatch
│   │   ├── read.ts
│   │   ├── write.ts
│   │   ├── edit.ts                           # apply_patch
│   │   ├── bash.ts                           # 用 permissions/bash/*
│   │   ├── git.ts                            # 自动 branch/commit/PR
│   │   ├── mcp-client.ts
│   │   ├── mcp-server.ts                     # envoy-harness 作为 MCP server
│   │   └── lsp-client.ts                     # 可选, parity with claw-code lane 8
│   ├── mcp/
│   │   ├── client.ts                         # MCP client SDK
│   │   ├── server.ts                         # MCP server SDK
│   │   ├── transport.ts                      # stdio + http transports
│   │   └── lifecycle.ts                      # spawn, health, shutdown
│   ├── config/
│   │   ├── loader.ts                         # TOML 加载 + layer 组合
│   │   ├── schema.ts                         # config.toml 的 Zod schemas
│   │   ├── profile.ts                        # profile 解析
│   │   └── profiles/
│   │       ├── read-only.toml
│   │       ├── workspace-write.toml
│   │       └── danger-full-access.toml
│   ├── verifier/
│   │   ├── rules/
│   │   │   ├── output-matches-objective.ts
│   │   │   ├── non-empty-content.ts
│   │   │   ├── sandbox-respected.ts
│   │   │   ├── approval-respected.ts
│   │   │   ├── task-shape.ts                 # output 符合 AgentResult schema
│   │   │   └── cost-reasonable-for-work.ts
│   │   ├── composite.ts                      # OR-of-pass, AND-of-fail
│   │   └── source-llm.ts                     # verifier LLM
│   ├── scoreboard/
│   │   ├── local.ts                          # per-node, per-runtime
│   │   └── ruleset-loader.ts                 # 加载 verifier-rules.json
│   ├── cost/
│   │   ├── tracker.ts                        # per-session cost
│   │   ├── estimator.ts                      # 执行前 cost 估计
│   │   └── report.ts                         # 执行后报告
│   └── errors/
│       └── tagged-error.ts                   # TaggedError + Result
├── bin/
│   └── envoy                                 # CLI entry point(shebang)
├── parity/
│   ├── 01-bash-validation.toml               # claw-code parity lane 1
│   ├── 02-sandbox.toml
│   ├── 03-file-tool.toml
│   ├── 04-task-registry.toml
│   ├── 05-task-wiring.toml
│   ├── 06-team-cron.toml                     # (可选 parity)
│   ├── 07-mcp-lifecycle.toml
│   ├── 08-lsp-client.toml                    # (可选 parity)
│   └── 09-permission-enforcement.toml
├── test/
│   ├── unit/                                 # per-module 单元测试
│   ├── e2e/                                  # 端到端 session 测试
│   └── parity/                               # 从 parity/*.toml 派生的可执行 parity 测试
└── docs/
    ├── USAGE.md                              # 怎么用 envoy
    ├── CONFIG.md                             # config.toml 参考
    ├── HOOKS.md                              # 12 个 hook event + 例子
    ├── MCP.md                                # MCP client + server
    └── SELF-EVOLUTION.md                     # 5 步协议参考
```

**三个结构性承诺:**

- 每个 `permissions/`、`sandbox/`、`hooks/`、`tools/` 子目录是**一个文件一个 seam** —— 加一个新的 permission mode 就是加一个文件,不是在现有文件里加分支。
- `parity/` 目录镜像 claw-code 的 9 个 lane。每个 lane 是一个单独的 TOML 文件,描述 parity 测试、canonical 行为和结果。CI 在每个 commit 跑全部 9 个。
- `tools/task.ts` 和 mesh 相关逻辑住在 **Package 3:`@envoymesh/envoy-harness-adapter`**,不在 envoy-harness 自身。envoy-harness 的 `tools/` **不**包含 task tool —— task tool 需要 mesh 连接。envoy-harness 对 mesh 不可知;adapter 带来 mesh。

#### 另两个 package

```
Package 2: @envoymesh/protocol       (住在 EnvoyMesh monorepo,带版本,published)
├── src/agent-adapter.ts             # AgentAdapter interface, manifest/result/verdict schemas
├── test/                            # contract 测试 —— envoy-harness 和 EnvoyMesh 都要过
└── package.json                     # @envoymesh/protocol

Package 3: @envoymesh/envoy-harness-adapter  (住在 EnvoyMesh monorepo, ~500 LoC)
├── src/index.ts                     # public API
├── src/adapter.ts                   # 为 envoy-harness 实现 AgentAdapter
├── src/manifest-broadcaster.ts      # 通过 libp2p 签名 + 发送 CapabilityManifest
├── src/chain-submit.ts              # 把一个 task 提交到 chain orchestrator
├── src/verdict-reader.ts            # 从 ArbitrationStore 读 VerdictEntry
├── src/reputation-book.ts           # 三元组 reputation book(本地视图)
├── src/mesh-local-runner.ts         # 在本节点跑一个 skill,被 adapter 使用
├── src/cli-shim.ts                  # adapter 加载后, `envoy task "..."` 就在这里被拦截
└── test/                            # 跟 envoy-harness 和 mock EnvoyMesh 的集成测试
```

**为什么这样切:**

- envoy-harness (Package 1) 对 mesh 零知识。Standalone 跑它的用户从来不加载 mesh adapter。
- adapter (Package 3) 是**唯一**知道 libp2p、mesh broadcast、chain submission 的地方。
- contract (Package 2) 小、稳定、带版本,两侧都有测试。

如果用户想在他们的类 mesh 项目(不是 EnvoyMesh)里用 envoy-harness,他们写自己的 Package 3 —— 约 500 LoC,对着稳定的 contract。

---

## 19. CLI 表面 (v0)

```
envoy [flags] [prompt-file | -]

Flags:
  --profile <name>              # Permission profile(默认:trusted 目录里 workspace-write,否则 read-only)
  --sandbox <mode>              # read-only | workspace-write | danger-full-access
  --approval <mode>             # unless-trusted | on-request | granular | never
  --model <id>                  # LLM model 标识符(如 claude-sonnet-4-6)
  --provider <name>             # LLM provider(openai、anthropic、ollama、custom)
  --plan                        # plan 模式:read + plan,不写
  --json                        # JSON Lines 输出(机器可读)
  --quiet                       # 抑制 human 输出,只输出 stream-json
  --cwd <path>                  # 覆盖 cwd
  --max-cost-usd <n>            # cost 上限(默认 5.00)
  --max-turns <n>               # turn 上限(默认 50)
  --no-mcp                      # 禁用 MCP client(仍作为 server)
  --no-extensions               # 禁用 envoy-harness extension
  --resume <session-id>         # 恢复之前的 session
  --fork <session-id>           # 在最后一个 user turn 处 fork 之前的 session
  --log <file>                  # log 目的地(默认:$ENVOY_HOME/logs/<session>.log)
  --no-color                    # 禁用 ANSI 颜色
  --verbose                     # 打印所有 hook 触发、全部 validator 判定

Subcommands:
  envoy task "<objective>"     # 把一个 sub-task 提交到 mesh(mesh-native)
  envoy hook <event> ...        # 手动触发一个 hook event
  envoy doctor                  # 健康检查(对应 codex 的 "codex doctor")
  envoy profile list            # 列出可用 profile
  envoy profile show <name>     # 显示 profile 内容
  envoy self-evolve             # 跑一轮 5 步自进化协议
  envoy scoreboard show         # 显示本地 + 联邦 scoreboard
  envoy broadcast               # 手动广播 manifest
  envoy agents                  # 显示已发现的 AGENTS.md 文件
  envoy cost                    # 显示当前 cost tracker

Slash commands(交互模式):
  /help                         # 列出 slash 命令
  /compact                      # 立即压缩 session
  /reload                       # 重新加载 config、hooks、AGENTS.md
  /status                       # 显示 session 状态
  /clear                        # 清屏
  /exit                         # 退出(Ctrl-D 也行)
  /diff                         # 显示待提交的改动
  /cost                         # 显示当前 cost
  /agents                       # 显示已发现的 AGENTS.md
  /hooks                        # 显示已注册的 hook
  /permissions                  # 显示当前 permission 状态
  /mode [mode]                  # 显示或修改 permission mode(仅本次 session)
  /approve-once <tool> <input>  # 预先批准一个具体的 tool call
```

**跟 Codex CLI 兼容:** `--sandbox`、`--approval`、`--profile`、`--model`、`--provider`、`--json`、`--resume`、`--fork` 用同样的 flag 名。会用 Codex 的用户不需要学新 flag。

**跟 Claude Code 兼容:** `--plan`、`--cwd`、`--max-cost-usd`、slash 命令用同样的名字。Hook event 名一致。意图是**drop-in mental model**。

### 19.1 `--resume` 和 `--fork` 实际做什么

`--resume <session-id>` 读 `$ENVOY_HOME/sessions/<id>.jsonl` 并从最后一个 turn 继续。Session 被加载进内存;用户在同一个 mode 里(如果在 workspace-write,继续在 workspace-write)。Cost 从断点继续累。

`--fork <session-id>` 跟 `--resume` 一样,但**创建一个新 session ID**,原 session 不被动。用户在 fork 里试错,不会污染原 session。对"如果当时用另一种方法呢"这种 debug 很有用。

---

## 20. Config schema 和 layer 组合

`$ENVOY_HOME/agent-state/<peer>/config.toml`:

```toml
# envoy-harness v0 config。尽量镜像 codex 的结构。

# === Permission 和 approval ===

# 两条独立轴。下面是默认值。
permission_mode = "read-only"             # read-only | workspace-write | danger-full-access
ask_for_approval = "on-request"           # unless-trusted | on-request | granular | never

# 可选:加载命名 profile。覆盖上面两行。
# profile = "work"                        # 查 $ENVOY_HOME/work.config.toml

# workspace-write 细节。
writable_roots = []                       # workspace-write 模式下可写的路径;[] = 只 cwd
network_access = false                    # 如果 true,workspace-write 模式下允许网络
exclude_slash_tmp = true                  # 如果 true,/tmp 可写

# === Sandbox backend ===

# 每个平台默认 backend:
#   Linux:   "linux-landlock"
#   macOS:   "process-fs-namespace"
#   Windows: "none"(只 DangerFullAccess)
sandbox_backend = "auto"                  # auto | linux-landlock | process-fs-namespace | none

# === AGENTS.md discovery ===

project_root_markers = [".git"]           # 什么标志停止向上 walk
project_doc_max_bytes = 32768            # AGENTS.md 总量 32 KB 上限
project_doc_fallback_filenames = []      # 除 AGENTS.md 外还要找的其他名字
local_override_filename = "AGENTS.override.md"

# === Hooks ===

# 同 codex/claude-code 名字。每个 entry 是一个 handler。
[[hook.PreToolUse]]
match = { tool = "bash" }
command = "echo $TOOL_CALL >> ~/.envoymesh/audit.log"

[[hook.PreToolUse]]
match = { tool = "write" }
module = "~/.envoymesh/hooks/redact-secrets.ts"

[[hook.PostToolUse]]
match = { tool = "*" }
command = "open $RESULT_FILE"

# === MCP servers(消费) ===

[[mcp_servers]]
name = "github"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_TOKEN = "ghp_..." }

# === MCP server(暴露 envoy-harness) ===

[mcp_server]
enabled = true
port = 7777
expose_tools = ["read", "write", "edit", "bash", "task", "git"]

# === Mesh(MAP) ===

[mesh]
agent_runtime = "envoy-harness"            # 这里永远是 envoy-harness
broadcast_interval_seconds = 150         # 2.5 分钟,manifest TTL 的一半
manifest_ttl_seconds = 300

# === 自进化(5 步协议) ===

[self_evolve]
# 严格的自进化规则。完整协议见 `docs/SELF-EVOLUTION.md`。
ruleset_path = "~/.envoymesh/agent-state/<peer>/verifier-rules.json"
scoreboard_path = "~/.envoymesh/agent-state/<peer>/verifier-scoreboard.yaml"
federated_scoreboard_opt_in = false       # opt-in 从其他 envoy-harness peer 拉规则
contamination_guard = true                # 永远 true。不要关。
benchmark_frozen_path = "~/.envoymesh/benchmarks/<name>/frozen.yaml"  # 协议要求

# === Cost ===

cost_ceiling_usd = 5.00
warn_at_usd = 4.00
```

### 20.1 Config layer 组合

Config 从 4 层加载,优先级递增(后者赢):

```
1. $ENVOY_HOME/agent-state/<peer>/config.dist.toml    # ship 出去的默认值
2. $ENVOY_HOME/agent-state/<peer>/config.toml         # 用户 config
3. .envoy/config.toml(在 cwd 里,可选)                 # 项目 config
4. CLI flags                                          # session 覆盖
```

TOML loader 按顺序合并;后面的 key 覆盖前面的。**Array 不合并 —— 替换。** 这是原则:可预期,无惊喜。

```ts
// src/config/loader.ts(草图)
export async function loadConfig(peerId: string, cwd: string, cliFlags: CliFlags): Promise<ResolvedConfig> {
  const dist = await tryReadToml(`~/.envoymesh/agent-state/${peerId}/config.dist.toml`)
  const user = await tryReadToml(`~/.envoymesh/agent-state/${peerId}/config.toml`)
  const project = await tryReadToml(path.join(cwd, '.envoy', 'config.toml'))
  const merged = mergeToml(dist, user, project)
  const withCli = applyCliFlags(merged, cliFlags)
  return ResolvedConfigSchema.parse(withCli)
}
```

---

## 21. Test 策略

### 21.1 单元测试

对 §18 每个 module,至少一个测试文件。具体:

- `permissions/mode.test.ts` —— 12 个轴组合全部正确解析。
- `permissions/bash/{read-only,destructive-warning,mode,sed,path,semantics}.test.ts` —— 每个 validator 的正向和反向 case,包括 200 条 command 的 fixture。
- `agents-md/discover.test.ts` —— cwd、project root、fallback、override、max bytes;monorepo fixture。
- `hooks/registry.test.ts` —— 全部 12 个 event;block 短路;modify 赢;add-context 拼接;middleware 短路。
- `verifier/composite.test.ts` —— rule 判定的全部组合;OR-of-pass、AND-of-fail、默认 disputed。
- `cost/tracker.test.ts` —— model call 已记录;cap 生效;threshold 告警;report shape。
- `config/loader.test.ts` —— layer 组合;CLI 覆盖;profile 解析。

### 21.2 Parity 测试(claw-code 风格)

`parity/*.toml` 文件通过自定义 test runner 变成可执行测试。每个 lane 是独立的测试,并行于 claw-code 的 9-lane mock parity harness。`parity/` 目录就是 **canonical 行为契约**。

例子:`parity/01-bash-validation.toml`(完整):

```toml
[meta]
name = "bash-validation"
description = "All 6 bash validators must run on every bash call."
evidence = "claw-code/PARITY.md:67, claw-code/rust/crates/runtime/src/bash_validation.rs"

[test.composition.all_six_run]
command = "ls -la"
expect_validators = ["read-only", "destructive-warning", "mode", "sed", "path", "command-semantics"]
expect_outcome = "allow"

[test.read-only.blocks_write]
mode = "read-only"
command = "echo hello > /tmp/foo"
expect = "block"
reason = "read-only mode cannot write"

[test.sed.blocks_system_path]
command = "sed -i 's/old/new/' /etc/hosts"
expect = "block"
reason = "sed -i on system path blocked"

[test.destructive.warning]
command = "rm -rf /"
expect = "allow-with-warning"
warning_matches = "destructive: targets root"

[test.path.outside_writable_roots]
mode = "workspace-write"
writable_roots = ["/home/alice/project"]
command = "bash"
argv = ["bash", "-c", "echo hi > /etc/foo"]
expect = "block"
reason = "path /etc/foo is outside writable_roots"
```

Runner 读 TOML,执行每个 test,任何 test 失败 CI 就挂。

### 21.3 E2E 测试

- `envoy --plan` 产出 plan.md 而不写其他东西。
- `envoy` 在 git repo 里会建 branch、commit、(若配置)开 PR。
- `envoy` 配 MCP server 时 spawn server、列 tool、调用一个。
- `envoy task "..."` 把一个 chain step 提交到 mesh(mock);orchestrator 挑一个 peer;结果被 verify。
- 5 步自进化:写一个 benchmark、跑一轮、观察一条 `kept` 或 `reverted` scoreboard entry。
- Resume:在某个 turn 中途 kill session,用 `--resume` 启动,验证 model 看到之前上下文。

### 21.4 测试数据

- 一个 fixture repo,已知的 AGENTS.md 层级(3 层嵌套,一个 override)。
- 一份 fixture bash command 列表(200 条,每条标 `block | warn | allow`)。
- 一份 frozen benchmark YAML(50 个 case,每个 verifier rule 的预期通过率)。
- 一个 mock model server(Anthropic 兼容,类似 claw-code 的 `rust/crates/mock-anthropic-service`)。

---

## 22. 迁移和时间线

### Phase 0 — 空 package(1 天,今天)

- 创建 `packages/envoy-harness/{package.json,tsconfig.json,src/index.ts,README.md}`。
- 在 MAP 设计的 `AgentRuntimeSchema` 里加 `envoy-harness` 作为第一个枚举值。
- 一个 PR。目标:结构性承诺。

### Phase 1 — v0 主干(4 周,1 个工程师)

- 全部文件骨架就位;6 个 bash validator 是真的;AGENTS.md discovery 是真的;hook registry 是真的;verifier rule engine 是真的;agent loop 跑得起来;CLI 收一个 prompt 出一个 response。
- 测试:6 个 bash validator 的 parity、AGENTS.md discovery、hook event、在 mock model 上的 agent loop。

### Phase 2 — Mesh-native(4 周)

- EnvoyHarnessAdapter 实现完整 MAP 表面。
- Manifest broadcast 跑通。
- `envoy task` 把 chain step 提交到 mesh。
- 三元组 reputation book 仅本地;arbitration 读工作。

### Phase 3 — 自进化(3 周)

- 5 步协议脚手架完成。
- 第一轮在 shadow 模式跑(不 commit)。
- Owner 私钥签的 scoreboard entry。
- 联邦 scoreboard opt-in(默认关)。

### Phase 4 — 生产级(✅ shipped,5 sub-chunks:F9.1–F9.5)

- ✅ **F9.1** 每调用 approval 回调(Penguin 风格)。Hook 返回 `ask` → agent 调 `askHandler` → handler 返回 `allow` / `deny` / `modify`。没有 handler → 安全 deny 默认。
- ✅ **F9.2** LSP client + 4 个 tool(跟 claw-code lane 8 同步)。`LspClient` 是 seam;envoy-harness 提供 `Tool` 表面;host(Tauri、CLI)提供实际的 per-file `LspClient`。v0:不 auto-spawn。
- ✅ **F9.3** Team + cron(跟 claw-code lane 6 同步)。手写极简 TOML reader(不依赖 `@iarna/toml`);顺序执行;`${input}` 替换;per-agent 失败 → `status: "failed"`。
- ✅ **F9.4** `--json` trace + `AgentOptions.tracer`。JSON Lines:每行一个 JSON 对象;`droppedEvents` 计数器;`WritableStream` 结构类型。
- ✅ **F9.5** 跨 agent 验证(MAP §CrossAgentDisagreementVerifier)。`verify()` 拼接 local + cross verdict;orchestrator 用 `combineVerdicts` 折叠。v0:`defaultCrossVerify` 在不同 adapter 上重跑。

### Phase 5 — Mesh-native sub-agents(✅ shipped,8 sub-chunks:F10.1–F10.6)

"真能跑"的 sub-agent 路径。`task` tool 是父 agent 的 escape hatch;它把 sub-agent 提交给 `MeshSubmitter`;submitter 执行(或路由)sub-agent,返回结果。按设计不变式 #9(sub-agent 是 NEW session —— 自己的 id、AGENTS.md、hooks、permission)和 §10.3。

- ✅ **F10.1** `MeshSubmitter` interface + `LocalMeshSubmitter` + `task` tool。每个 sub-agent 一个新的 local session(4 个 sub-chunks:types、noop submitter、local submitter + default factory、e2e)。
- ✅ **F10.2** Parallel fan-out + `maxSubagents` cap(默认 8)。`executeToolCalls` helper 自动检测 "all task" → `Promise.all`;混合 iteration 保持 serial;超 cap 时拒绝 ALL。
- ✅ **F10.3.1** `SubagentResultSigner` seam(`(result: SubagentResult) => string`)。可选;向后兼容:无 signer = 空 signature。
- ✅ **F10.3.2** `RemoteMeshSubmitter`(Package 3)+ `RemoteSubmitterTransport` seam。薄 wrapper:1 行 `submit()` → `transport.send()`。Transport 承担 ALL crypto + wire format。**相对 F10.3 plan 的设计 pivot:**F10.3.1 plan 把 `workerPublicKey` + `parentPrivateKey` 放在 submitter 上;延后到 transport 的 contract(更干净的 seam;adapter 不需要知道 key)。
- ✅ **F10.3.3** `RoutingHint { workerCapabilityTag, maxHops?, preferredRegions? }`(host-only;不在 model 的 `task` tool zod schema 里)。Mesh 来解释它。**Routing 是 mesh 的事;envoy-harness 暴露 hint,EnvoyMesh 决定 target。**
- ✅ **F10.4.1** `FanOutSpec { capabilityTag, count, partition? }` + `FanOutRegistry`。Host-driven fan-out(对比 F10.2 的 model-driven)。当 model 发 ONE 个 `task` call 且 tag 匹配,tool 通过 `Promise.all`(F10.2 路径)展开成 N 个并行 sub-agent,然后聚合。**Worst-case 聚合**(status、verdict);content 用 `[sub-agent i/N]` header 拼接;`costUsd` 求和;`durationMs` 取最大;聚合 result 的 signature 为空。
- ✅ **F10.5** Cost aggregation + progress streaming。`CostTracker.addSubagentCost(costUsd)`(additive;不做 token 归属 —— sub-agent 在自己的 `CostTracker` 里已经记过自己的 token;parent 只看派生的 `costUsd` 求和)。`LocalMeshSubmitterOptions.parentTracer?` + `defaultBuildSubagentFactory({parentTracer?})`(sub-agent 的 `TraceEvent` 流到 parent tracer,做 progress streaming)。
- ✅ **F10.6** `subagentOf` trace annotation。`TraceBase.subagentOf?: string`(additive);6 个 `TraceEvent` variant 都继承它。`AgentOptions.subagentOf?: string` 是新 option(sub-agent 填,parent 不填)。私有的 `emit()` helper 集中处理 propagation(替换 9 处内联 `tracer.emit(...)`;一处改,处处生效)。`defaultBuildSubagentFactory({parentSessionId?})` —— host 传 parent 的 sessionId;factory 在闭包里捕获它。**为什么是这个而不是 per-sub-agent cost breakdown**(按用户在 F10.6 plan 里的取舍):breakdown 是 scope creep(host 有 workaround;数据在 trace event 里;会膨胀 `SubagentResult`)。`subagentOf` 字段在低成本下填了一个真实缺口(consumer 侧从 event 顺序推断在并行 sub-agent 下是脆弱的)。

**到 v0 ship-ready 总计:约 12 周,1-2 个工程师**(Phase 0–3 是原估算;Phase 4 + 5 是 v0 之后的增量工作,现在都 ship 了)。

---

## 23. 决策总结(已决定 vs 暂不决定)

---

## 23. 决策总结(已决定 vs 暂不决定)

### 已决定

| # | 决策 | 理由 |
|---|---|---|
| 1 | 默认 `permission_mode = "read-only"` | 第一印象重要;安全默认值 |
| 2 | Permission 和 approval 是分开的两条轴 | 12 个格子,不是 3 个;跟 codex 一致 |
| 3 | AGENTS.md discovery:walk-up + concat,不是 first-found | Monorepo 有多份文档 |
| 4 | Bash 有 6 个 validator,不是 1 个 | Bash 事故常见;组合才是故事 |
| 5 | 12 个 hook event,固定集合 | 心理模型可移植 + 可审计 |
| 6 | MCP 双向 | 网络效应 |
| 7 | Sub-agent 映射到 mesh chain step | Mesh-native |
| 8 | 自进化目标是 verifier ruleset + AGENTS.md | 两者都是持久身份 |
| 9 | Cost 按 turn 记,不按 session | 用户能看到增长 |
| 10 | 跨节点一切都用 owner key 签名 | 跨节点验证 |
| 11 | Tool dispatch 永不抛异常 | 错误在 model context 里可见 |
| 12 | Config 用 TOML,不是 JSON 或 YAML | 跟 codex + cargo 一致 |
| 13 | TypeScript,不是 Rust | 跟 EnvoyMesh host 一致 |
| 14 | envoy-harness 是 adapter *之一*,不是系统 agent | 避免被收编;保证开放竞争 |
| 15 | `parity/` 目录作为 canonical 行为契约 | claw-code 模式有效 |

### 暂不决定

| # | 决策 | 为什么延后 | 何时 |
|---|---|---|---|
| D1 | 默认 verifier LLM 用哪个本地 model? | 取决于用户 model 选择 | Phase 4 |
| D2 | v0 是 Web UI 还是只 TUI? | TUI 够了;web 留给 launch 后 | v0 之后 |
| D3 | 多 agent workspace 共享? | 设计工作量很大;v0 不在范围内 | v0 之后 |
| D4 | `lsp-client` 跟 claw-code lane 8 parity? | 有用但不阻塞 | Phase 4 |
| D5 | Hook 是否直接支持 async/await? | 当前是 fire-and-forget;同步可能错了 | Phase 4 |

---

## 24. 开放问题

1. **语言:TypeScript 还是 Rust?** Codex 是 Rust;claw-code 是 Rust 移植;envoy-harness 的 host(EnvoyMesh)是 TypeScript。**TS 让类型系统跟 mesh 其它部分对齐。** 建议 v0 用 TS;如果性能变成约束再考虑 Rust 移植。

2. **Provider 抽象层。** envoy-harness 需要对接 OpenAI、Anthropic、Ollama、vllm、自定义端点。借鉴 Pi 的 `pi-ai`(统一多 provider API)还是自己写薄 adapter?建议:薄 adapter,因为 envoy-harness 的需求比 Pi 小。

3. **本地 model 支持深度。** Codex 开箱支持 Ollama。envoy-harness 应该 ship 自家 Ollama recipes,还是文档说用户用 OpenClaw?建议:ship 最常见的(Ollama);长尾 delegate 给 OpenClaw。

4. **"danger-full-access" 在 mesh 上下文里到底什么意思。** 在 mesh-native 下,agent 可以在另一个节点 spawn 一个 sub-agent。Sub-agent 跑在远程节点的本地 sandbox,**不是** requester 的 sandbox。**`danger-full-access` 是 per-node 还是 per-mesh?** 建议:per-node。Requester 的 `danger-full-access` 不传递。

5. **联邦自进化:pull 模型还是 push 模型?** 目前:pull(peer B 拉 peer A 的规则)。要不要 push(peer A 的规则自动提供给所有跑同 runtime 的 envoy-harness 节点)?建议:pull,显式 opt-in。Pull 工作后再 push。

6. **跨 mesh 的 cost 归属。** 当一个 chain step 跑在远程节点,费用由 requester 付。但 verifier LLM(用于跨 agent 验证)的费用谁付?建议:requester(跟 chain-budget-ledger 的 reserve/commit 语义一致)。**Phase 5 (F10.5) 部分已处理:** sub-agent 派生的 `costUsd` 通过 `CostTracker.addSubagentCost(costUsd)` 求和到 parent 的 `CostTracker`。**Token 归属被故意不做** —— sub-agent 在自己的 `CostTracker` 里已经记过自己的 token;在 parent 这边重复记 token 会算错。跨 agent 验证的 verifier LLM cost 归属仍 TBD。

7. **add-context 的 hook 决策语义。** 目前:所有 `add-context` 拼接。要不要 per-tool、per-session、per-event?建议:当前行为(concat)v0 够用;用户抱怨时再回头看。

---

## 25. 参考资料

### 来自具体真实代码库的概念

| 概念 | 来源 | 在源码中的位置 |
|---|---|---|
| AGENTS.md discovery | codex | `codex-rs/core/src/agents_md.rs:1-90` |
| `AGENTS.override.md` | codex | `codex-rs/core/src/agents_md.rs:38-39` |
| `project_doc_max_bytes` 预算 | codex | `codex-rs/core/src/agents_md.rs:74-77` |
| `SandboxMode` 枚举(3 级) | codex | `codex-rs/protocol/src/config_types.rs:86-96` |
| `AskForApproval` 枚举(4 级) | codex | `codex-rs/protocol/src/protocol.rs:915-939` |
| 6 个 bash validator(命名) | claw-code | `claw-code/PARITY.md:67` |
| `PermissionEnforcer` | claw-code | `claw-code/rust/crates/runtime/src/permission_enforcer.rs:1-50` |
| 9-lane parity harness | claw-code | `claw-code/PARITY.md:42-52` |
| 12 个 hook event 名 | codex | `codex-rs/core/src/hook_runtime.rs:8-32` |
| Profile 选择 | codex | `codex-rs/protocol/src/config_types.rs:98-130` |
| `TaggedError` + `Result` | pi | `pi/packages/agent/src/harness/agent-harness.ts:28-55` |
| 5 步自进化 | penguin | `penguin-harness/examples/self-improving-agent/self-evolve.ts` |
| MAP 协议(manifest/result/verdict) | envoymesh-design(前作) | `envoymesh-design/improving-agent-network.en.md` §4 |
| 三元组 reputation | envoymesh-design(前作) | `envoymesh-design/improving-agent-network.en.md` §7 |
| 跨 agent 验证 | envoymesh-design(前作) | `envoymesh-design/improving-agent-network.en.md` §8 |
| 形式化 effect tracking(未来) | deepseek | `deepseek-harness/vendor/cordis/` |

### 灵感和相邻工作

- **DeepSeek-Harness**:长期愿景(形式化 effect tracking、capability seam)
- **Penguin-Harness**:5 步自进化协议、scoreboard、contamination guard
- **Pi**:极简 extension 模型、TaggedError、Agent Skills 标准
- **Codex CLI**:3-mode sandbox、4-mode approval、AGENTS.md discovery、hook event 名
- **Claude Code / claw-code**:plan 模式、permission UX、MCP 集成、sub-agent、9-lane parity harness
- **EnvoyMesh 自己的 MAP 设计**:envoy-harness 原生说的 wire 协议
