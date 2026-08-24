/**
 * Phase G — built-in system-prompt sections.
 *
 * Environment context follows Codex's `<environment_context>` shape
 * (cwd + shell) and Claude Code's CWD/platform block. Identity,
 * persona, permissions, and tool guidance follow DeepSeek's ordered
 * section slots (MIT-adapted text).
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { discoverAgentsMd, type DiscoveryOptions } from "../agents-md/index.js";
import type { AskForApproval, PermissionMode } from "../types.js";
import type { PromptSection } from "./types.js";

/**
 * Default project-doc fallbacks after AGENTS.md (primary).
 * ENVOY.md = native; CLAUDE.md = Claude Code compat; CONTRIBUTING.md = common.
 */
export const DEFAULT_PROJECT_DOC_FALLBACKS = [
  "ENVOY.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
] as const;

/**
 * The AGENTS.md section (order -100, deepseek's identity/context slot).
 * Also discovers ENVOY.md / CLAUDE.md / CONTRIBUTING.md via fallbackFilenames.
 */
export function agentsMdSection(
  cwd: string,
  options: Omit<DiscoveryOptions, "cwd"> = {},
): PromptSection {
  const fallbackFilenames =
    options.fallbackFilenames ?? [...DEFAULT_PROJECT_DOC_FALLBACKS];
  return {
    name: "agents-md",
    order: -100,
    text: async () => {
      try {
        const loaded = await discoverAgentsMd({
          cwd,
          ...options,
          fallbackFilenames,
        });
        return loaded.assembled;
      } catch {
        return "";
      }
    },
  };
}

/** DeepSeek-style harness opener (order -101, before AGENTS.md). */
export function harnessIdentitySection(): PromptSection {
  return {
    name: "harness:identity",
    order: -101,
    text: "You are an AI coding agent powered by Envoy Harness.",
  };
}

/** Optional deployment persona (order 0). Empty text is skipped by the registry. */
export function personaSection(persona: string): PromptSection {
  return {
    name: "deployment:persona",
    order: 0,
    text: persona.trim(),
  };
}

/** Host/developer instructions (order 10). */
export function developerInstructionsSection(text: string): PromptSection {
  return {
    name: "developer_instructions",
    order: 10,
    text: text.trim(),
  };
}

/** The plan-mode section (order -50, after project context). */
export function planModeSection(text: string): PromptSection {
  return { name: "plan-mode", order: -50, text };
}

/**
 * Claude-style permission literacy (order 60).
 * Enforcement is host-side; this tells the model how to behave.
 */
export function permissionsPolicySection(opts: {
  permissionMode: PermissionMode;
  askForApproval?: AskForApproval;
}): PromptSection {
  const approval = opts.askForApproval ?? "on-request";
  return {
    name: "permissions:policy",
    order: 60,
    text:
      `Tools run under permission mode \`${opts.permissionMode}\` ` +
      `with approval policy \`${approval}\`. ` +
      `When a tool is denied or needs user approval, do not immediately re-attempt ` +
      `the same call — adjust the approach, ask the user, or use a narrower tool. ` +
      `Prefer read_file/edit/write over shell for file I/O inside the workspace.`,
  };
}

/**
 * Interaction guidance: ask_user options + plan/agent mode switches (order 65).
 */
export function interactionGuidanceSection(): PromptSection {
  return {
    name: "interaction:guidance",
    order: 65,
    text:
      "When you need a decision, call `ask_user` with short `options` and set " +
      "`recommendedIndex` to your preferred choice. For large or risky work, call " +
      "`enter_plan_mode` so the human can switch to plan mode; when the plan is ready, " +
      "call `exit_plan_mode` with the full markdown plan for approval.",
  };
}

/**
 * Codex/Claude-style environment block (order -95).
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
 * Terminal guidance (order 100). Text adapted from deepseek terminal tool (MIT).
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

/** DeepSeek tool:read guidance — mapped to envoy `read_file` (order 102). */
export function readFileGuidanceSection(): PromptSection {
  return {
    name: "tool:read_file",
    order: 102,
    text:
      "Use the read_file tool — not shell commands like cat — to inspect text files. " +
      "Results include line numbers. Use offset and limit to continue reading large files.",
  };
}

/** DeepSeek tool:bash guidance (order 105). */
export function bashGuidanceSection(): PromptSection {
  return {
    name: "tool:bash",
    order: 105,
    text:
      "Check the [exit code: N] marker on every bash result; investigate failures before moving on.",
  };
}

/** DeepSeek tool:jobs guidance (order 106). */
export function jobsGuidanceSection(): PromptSection {
  return {
    name: "tool:jobs",
    order: 106,
    text:
      "Track every background job id you start. You are notified in-session when a job finishes — " +
      "do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a " +
      "running job's work. Before giving a final answer, collect every still-relevant job with " +
      "job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs " +
      "that stopped mattering.",
  };
}

/** DeepSeek tool:web_search guidance (order 110). */
export function webSearchGuidanceSection(): PromptSection {
  return {
    name: "tool:web_search",
    order: 110,
    text:
      "Use the web_search tool to discover current information on the web. " +
      "Follow up with web_fetch when you need the full content of a specific result, " +
      "and cite the relevant URLs as markdown links.",
  };
}
