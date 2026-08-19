/**
 * F17.2.5 — Tier 1 info commands.
 *
 * 8 print/info commands that fill the gap between the F17.2
 * basics and what codex / claude-code / pi ship. The data
 * sources already exist (`agent.getCost`, `agent.getSessionId`,
 * `agent.getLspServers`, `agent.getHooks`, the scoreboard
 * from F6, the verifier from §12, the TOML profile config
 * from the README); these commands just format them.
 *
 * **Tier 1 = no new agent capabilities.** No compaction
 * algorithm, no AGENTS.md generation, no journaled action
 * log. Just data display.
 *
 * | Command             | Source                                |
 * |---------------------|---------------------------------------|
 * | `/session`          | `agent.getSessionId()`                 |
 * | `/context`          | `agent.getMessageCount()` + `getCost()`|
 * | `/scoreboard`       | `ctx.scoreboard` (F6, optional)       |
 * | `/rules`            | `ctx.verifierRules` (optional)        |
 * | `/lsp`              | `agent.getLspServers()`                |
 * | `/hooks`            | `agent.getHooks()`                     |
 * | `/mcp`              | v0 placeholder (no MCP servers yet)   |
 * | `/profile [name]`   | `ctx.profileLoader` (optional)         |
 *
 * **Stability:** `BUILTIN_INFO_COMMANDS` is the public surface.
 * Adding new info commands is additive.
 */

import { DEFAULT_RULES, type VerifierRule } from "../../index.js";
import type { ReplCommand } from "./types.js";

// ---------------------------------------------------------------------------
// 1. /session — print the current session id
// ---------------------------------------------------------------------------

const sessionCommand: ReplCommand = {
  name: "/session",
  description: "print the current session id",
  handler(_args, ctx) {
    ctx.stdout.write(`session: ${ctx.agent.getSessionId()}\n`);
  },
};

// ---------------------------------------------------------------------------
// 2. /context — print message count + input/output tokens
// ---------------------------------------------------------------------------

const contextCommand: ReplCommand = {
  name: "/context",
  description: "print transcript size + token usage",
  handler(_args, ctx) {
    const messageCount = ctx.agent.getMessageCount();
    const cost = ctx.agent.getCost();
    ctx.stdout.write(
      `messages: ${messageCount} ` +
        `| in: ${cost.inputTokens} | out: ${cost.outputTokens} ` +
        `| cost: $${cost.costUsd.toFixed(4)}\n`,
    );
  },
};

// ---------------------------------------------------------------------------
// 3. /scoreboard — list scoreboard entries (when a scoreboard is loaded)
// ---------------------------------------------------------------------------

const scoreboardCommand: ReplCommand = {
  name: "/scoreboard",
  description: "print the federated scoreboard (when loaded)",
  handler(_args, ctx) {
    const scoreboard = ctx.scoreboard;
    if (!scoreboard) {
      ctx.stdout.write("no scoreboard loaded (start envoy with --self-evolve to populate)\n");
      return;
    }
    // F17.2.5 v0: print the scoreboard path + entry count.
    // The detailed entry listing is a future chunk (the
    // FederatedScoreboard has a read API; we expose the
    // path + count for now).
    const entries = scoreboard.entries?.() ?? [];
    ctx.stdout.write(`scoreboard: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}\n`);
  },
};

// ---------------------------------------------------------------------------
// 4. /rules — print the active verifier rules
// ---------------------------------------------------------------------------

const rulesCommand: ReplCommand = {
  name: "/rules",
  description: "print the active verifier rules",
  handler(_args, ctx) {
    // `ctx.verifierRules` overrides DEFAULT_RULES when set
    // (the host injects custom rules via AgentOptions).
    const rules: ReadonlyArray<VerifierRule> = ctx.verifierRules ?? DEFAULT_RULES;
    if (rules.length === 0) {
      ctx.stdout.write("no verifier rules\n");
      return;
    }
    const lines: string[] = [];
    for (const r of rules) {
      lines.push(`  ${r.name.padEnd(20)}  ${r.description ?? ""}`);
    }
    ctx.stdout.write(lines.join("\n") + "\n");
  },
};

// ---------------------------------------------------------------------------
// 5. /lsp — list active LSP servers (from agent.lspManager)
// ---------------------------------------------------------------------------

const lspCommand: ReplCommand = {
  name: "/lsp",
  description: "list active LSP servers",
  handler(_args, ctx) {
    const servers = ctx.agent.getLspServers();
    if (servers.length === 0) {
      ctx.stdout.write("no LSP servers configured (set AgentOptions.lspManager)\n");
      return;
    }
    const lines: string[] = [];
    for (const s of servers) {
      lines.push(`  ${s.language.padEnd(12)}  ${s.rootUri}`);
    }
    ctx.stdout.write(lines.join("\n") + "\n");
  },
};

// ---------------------------------------------------------------------------
// 6. /hooks — list registered hooks
// ---------------------------------------------------------------------------

const hooksCommand: ReplCommand = {
  name: "/hooks",
  description: "list registered hooks",
  handler(_args, ctx) {
    const hooks = ctx.agent.getHooks();
    if (hooks.length === 0) {
      ctx.stdout.write("no hooks registered\n");
      return;
    }
    const lines: string[] = [];
    for (const h of hooks) {
      const noun = h.handlerCount === 1 ? "handler" : "handlers";
      lines.push(`  ${h.event.padEnd(20)}  ${h.handlerCount} ${noun}`);
    }
    ctx.stdout.write(lines.join("\n") + "\n");
  },
};

// ---------------------------------------------------------------------------
// 7. /mcp — list MCP servers (v0: not implemented)
// ---------------------------------------------------------------------------

const mcpCommand: ReplCommand = {
  name: "/mcp",
  description: "list MCP servers (v0: not implemented)",
  handler(_args, ctx) {
    // envoy-harness has bidirectional MCP per design §11
    // (MCP client + MCP server). v0 ships the LSP
    // integration (F9.2) and the `task` tool (F10.1); the
    // MCP server registry lands in a future chunk. For
    // now, the command prints the placeholder.
    void ctx; // reserved for future use
    ctx.stdout.write("no MCP servers (the MCP integration lands in a future chunk)\n");
  },
};

// ---------------------------------------------------------------------------
// 8. /profile [name] — list profiles or show a specific profile
// ---------------------------------------------------------------------------

/**
 * The shape of a TOML profile, as documented in the README.
 * Keys are optional (a profile may set only some of them).
 */
export interface ReplProfile {
  provider?: string;
  model?: string;
  sandbox?: string;
  approval?: string;
  [key: string]: unknown;
}

const profileCommand: ReplCommand = {
  name: "/profile",
  description: "list profiles or show a specific profile",
  handler(args, ctx) {
    if (!ctx.profileLoader) {
      ctx.stdout.write(
        "no profile loader configured " +
          "(host injects a profileLoader via ReplOptions)\n",
      );
      return;
    }
    if (args.length === 0) {
      const names = ctx.profileLoader.list();
      if (names.length === 0) {
        ctx.stdout.write("no profiles in config\n");
        return;
      }
      ctx.stdout.write(`profiles: ${names.join(", ")}\n`);
      return;
    }
    const name = args[0];
    if (name === undefined) {
      ctx.stdout.write("usage: /profile [name]\n");
      return;
    }
    const profile = ctx.profileLoader.get(name);
    if (!profile) {
      ctx.stderr.write(`unknown profile: ${name}\n`);
      return;
    }
    const lines: string[] = [`profile: ${name}`];
    for (const [k, v] of Object.entries(profile)) {
      lines.push(`  ${k.padEnd(12)}  ${String(v)}`);
    }
    ctx.stdout.write(lines.join("\n") + "\n");
  },
};

/**
 * F17.2.5: list of the 8 Tier 1 info commands. The runner
 * includes this in the default registry alongside the
 * F17.2 commands (`BUILTIN_COMMANDS`).
 *
 * **Defined last** because each entry is a `const` declared
 * above. Forward references in `const` arrays would force
 * us to either inline the literals (less readable) or
 * convert each command to a function declaration (less
 * idiomatic for a data literal). The bottom-of-file
 * position is the cleanest fix (same pattern as
 * `BUILTIN_COMMANDS` in `commands.ts`).
 */
export const BUILTIN_INFO_COMMANDS: ReadonlyArray<ReplCommand> = [
  sessionCommand,
  contextCommand,
  scoreboardCommand,
  rulesCommand,
  lspCommand,
  hooksCommand,
  mcpCommand,
  profileCommand,
];
