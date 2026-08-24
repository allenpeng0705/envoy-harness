/**
 * Phase G — built-in system-prompt sections.
 *
 * Environment context follows Codex's `<environment_context>` shape
 * (cwd + shell) and Claude Code's CWD/platform block so the model
 * knows the selected project folder without being told again.
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { discoverAgentsMd, type DiscoveryOptions } from "../agents-md/index.js";
import type { PromptSection } from "./types.js";

/**
 * The AGENTS.md section (order -100, deepseek's identity/context slot).
 * Wires the (previously disconnected) discovery pipeline into the prompt.
 */
export function agentsMdSection(
  cwd: string,
  options: Omit<DiscoveryOptions, "cwd"> = {},
): PromptSection {
  return {
    name: "agents-md",
    order: -100,
    text: async () => {
      // Best-effort: a failed discovery (missing root, permission error)
      // contributes nothing rather than crashing the run.
      try {
        const loaded = await discoverAgentsMd({ cwd, ...options });
        return loaded.assembled;
      } catch {
        return "";
      }
    },
  };
}

/** The plan-mode section (order -50, after project context). */
export function planModeSection(text: string): PromptSection {
  return { name: "plan-mode", order: -50, text };
}

/**
 * Codex/Claude-style environment block (order -95).
 *
 * Codex injects a user message:
 *   <environment_context><cwd>…</cwd><shell>…</shell></environment_context>
 * Claude Code injects `CWD: …` plus platform/OS into the dynamic system
 * section. We put the same facts in the system prompt so ACP/chat hosts
 * that only wire `Agent.systemPrompt` still get them.
 */
export function workspaceSection(cwd: string): PromptSection {
  const abs = path.resolve(cwd);
  const shell =
    process.env.SHELL?.split(/[/\\]/).pop() ??
    (process.platform === "win32" ? "cmd" : "sh");
  const isGit = existsSync(path.join(abs, ".git"));
  return {
    name: "workspace",
    order: -95,
    text:
      `<environment_context>\n` +
      `  <cwd>${abs}</cwd>\n` +
      `  <shell>${shell}</shell>\n` +
      `  <platform>${process.platform}</platform>\n` +
      `  <os>${os.type()} ${os.release()}</os>\n` +
      `  <is_git_repo>${isGit ? "true" : "false"}</is_git_repo>\n` +
      `</environment_context>\n\n` +
      `The <cwd> above is the user's selected project workspace. ` +
      `When they say "the project", "this repo", or "the codebase", they mean that directory. ` +
      `Use tools (list/read files under cwd) to explore it — do not ask which project they mean.`,
  };
}

/**
 * The terminal guidance section (order 100, deepseek's tool-guidance slot).
 * Text adapted from `@deepseek-ai/dsh-tool-terminal` (MIT) with envoy's
 * tool names.
 */
export function terminalGuidanceSection(): PromptSection {
  return {
    name: "terminal:guidance",
    order: 100,
    text:
      "Use a terminal session only when work needs persistent terminal " +
      "state or interactive stdin; prefer bash/read_file/write/edit for " +
      "bounded one-shot operations. Track every terminal session id and " +
      "close sessions that no longer matter. An inferred_idle or timeout " +
      "result does not prove the foreground command exited.",
  };
}
