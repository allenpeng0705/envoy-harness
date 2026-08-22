# Reusing deepseek-harness tools and skills

> **Status:** 2026-08-22. How envoy-harness reuses the deepseek ecosystem —
> skills (format), capability providers (Cordis container), and MCP tools
> (universal bridge) — and what we deliberately do NOT reuse.

## The layered answer

| What to reuse | How | Layer | Status |
|---|---|---|---|
| Skills (SKILL.md files) | envoy's skill loader reads deepseek's roots + catalog projection | L0 (format) | ✅ live |
| Capability providers (jobs, skills backend, credentials, web search) | Cordis-compat container hosts the published plugins + C4 bridges | L4 (runtime) | ✅ live |
| MCP tool servers (any ecosystem) | MCP tool bridge (`mcp__server__tool` naming) | L0/L5 (standard) | ✅ live |
| deepseek's model-facing tool plugins (tool-bash, tool-terminal, …) | **Do NOT reuse** — own implementations are stronger; plugins sit on stale `dsh-tools` | — | deliberate no |

## 1. Reuse deepseek skills (no code needed)

Skills are `SKILL.md` markdown files. Envoy's skill loader scans the same
roots deepseek uses:

```
<project>/.dsh/skills/      project-local (deepseek compat)
~/.dsh/skills/              user-level (deepseek compat)
~/.agents/skills/           universal (emerging Agent Skills spec)
```

Drop a deepseek skill into any of those roots and envoy discovers it:

```ts
import { createSkillRegistry, createFilesystemSkillProvider, registerSkillTools } from "@envoymesh/envoy-harness";

const skills = createSkillRegistry();
skills.registerProvider(createFilesystemSkillProvider({ homeDir: os.homedir() }));
const tools = new ToolRegistry();
registerSkillTools(tools, skills); // `skill` + `skill_list`
```

The model sees the **catalog projection** (`skill_list` → `<available_skills>`
block, deepseek's shape) and loads a skill body via the `skill` tool (the
canonical `<skill_content>` block). Hosts that want the durable pre-request
catalog inject `createSkillCatalogFragment(summaries)` as a bounded
user-role fragment; `nextCatalogMessage` re-publishes only when the digest
changes (deepseek's cache-friendly semantics).

## 2. Reuse deepseek capability providers (the Cordis container)

The container hosts audited deepseek plugins that *provide* capabilities,
and the C4 bridges feed them into envoy's own tools:

```toml
# config.toml (envoy-harness host)
[cordis]
plugins = [
  { name = "jobs-local" },                 # ctx.jobs
  { name = "skill-filesystem" },           # ctx.skills provider
  { name = "credentials-local" },          # ctx.credentials
  { name = "web-search-exa" },             # ctx.web provider
]
```

```ts
import { createCordisContainer, createHostedSkillsProvider, createHostedJobsRegistry } from "@envoymesh/envoy-harness-cordis";

const container = await createCordisContainer({ plugins: [{ name: "jobs-local" }] });
const skills = createSkillRegistry();
skills.registerProvider(createHostedSkillsProvider(container.ctx)); // deepseek skills → envoy skill tool
const jobs = createHostedJobsRegistry(container.ctx);               // deepseek jobs → envoy job tools
```

Every plugin needs an audit record (see `packages/envoy-harness-cordis/docs/audit-*.md`)
before it may load; versions are pinned exactly.

## 3. Reuse MCP tools (the universal bridge)

MCP is the industry's tool interface (Codex, Claude Code, and deepseek's own
`dsh-mcp-client` all use the `mcp__<server>__<tool>` naming). Connect any
MCP server and its tools become envoy tools through the bridge:

```ts
import { DefaultMcpClientRegistry, StdioMcpClient, registerMcpTools, ToolRegistry } from "@envoymesh/envoy-harness";

const registry = new DefaultMcpClientRegistry();
registry.register(new StdioMcpClient({
  serverName: "github",
  process: spawnMcpServer(["npx", "-y", "@modelcontextprotocol/server-github"]),
}));
await registry.get("github")?.connect();

const tools = new ToolRegistry();
const { registered, catalog } = await registerMcpTools(tools, registry);
// model sees: mcp__github__create_issue, mcp__web__search, …
```

Calls route to the right client with the raw tool name; results render as
text (images summarized); client errors become `isError` tool results. The
registered tools flow through envoy's hooks, permissions, and sandbox like
any native tool. **Prefer the bridge over `AgentOptions.mcpClients` for
governance:** `mcpClients` alone exposes MCP tools to the model with direct
client routing (no envoy hooks/permissions); a bridge-registered tool is
routed through the normal tool layer (hooks, arg validation, permissions),
and the loop deduplicates it from the raw MCP list.

## 4. What we deliberately do NOT reuse

- **`tool-bash`, `tool-terminal`** — envoy's own bash tool (6 validators +
  sandbox) and terminal (feature parity, own implementation) are stronger
  and avoid upstream sync. See `cordis-compat-plan.md` "C3 terminal decision".
- **`dsh-tools` / `tool-skill` / `tool-jobs` model-facing plugins** — they sit
  on the stale `0.0.1-rc.x` tool stack; envoy's native tools already cover
  the capability, and the container bridges deepseek's *backends* into them.
- **`dsh-system-prompt`** — an assembler whose contributors are stale or
  unhosted; envoy's native section registry mirrors its `{ name, order, text }`
  shape so future contributions copy in cleanly (MIT).

## Decision rationale

Reuse the ecosystem where the shared contract is the value (skills = the
format; MCP = the protocol; providers = the implementations worth depending
on). Keep own implementations where security, sandboxing, and loop coupling
live (bash, terminal, tools, system prompt). This gives deepseek's ecosystem
surface without adopting its agent stack or its sync debt.
