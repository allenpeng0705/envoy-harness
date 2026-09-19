/**
 * REPL slash commands on an ACP session.
 *
 * A prompt whose text starts with `/` is dispatched here and never
 * reaches the model. `/quit` and `/exit` do not kill the process —
 * the host owns the task. The command list is the same registry the
 * REPL builds, published as `available_commands_update` (names without
 * the leading slash, hidden aliases omitted).
 *
 * The registry is loaded on first use. Importing the command modules
 * at the top of this file would cycle through the package barrel.
 */

import { Writable } from "node:stream";

import type { Agent } from "../agent.js";
import type { RunParsedArgs } from "../cli/argv-types.js";
import {
  dispatchCommand,
  parseCommandLine,
  type ReplCommandRegistry,
} from "../cli/repl/registry.js";
import type { MemoryStore } from "../memories/store.js";
import type { PermissionMode } from "../types.js";
import type {
  ProtocolCommittedMessage,
  ProtocolPromptInput,
  ProtocolPromptResult,
} from "./session-backend.js";

export interface AcpAvailableCommand {
  name: string;
  description: string;
}

const SESSION_STAYS_OPEN =
  "This session stays open. Close the task when you are done.";

interface SlashState {
  args: RunParsedArgs;
  turns: number;
  totalCostUsd: number;
  lastResponse?: string;
}

const states = new WeakMap<Agent, SlashState>();
let registryPromise: Promise<ReplCommandRegistry> | undefined;

async function loadRegistry(): Promise<ReplCommandRegistry> {
  if (registryPromise === undefined) {
    registryPromise = import("../cli/repl/builtin-registry.js").then((mod) =>
      mod.buildBuiltinRegistry(),
    );
  }
  return registryPromise;
}

/** Visible commands, names without the leading slash. Hidden aliases stay hidden. */
export async function acpAvailableCommands(): Promise<AcpAvailableCommand[]> {
  const registry = await loadRegistry();
  return registry.listVisible().map((command) => ({
    name: command.name.replace(/^\//, ""),
    description: command.description,
  }));
}

export async function notifyAcpAvailableCommands(
  notify: (method: string, params: unknown) => void,
  sessionId: string,
): Promise<void> {
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: await acpAvailableCommands(),
    },
  });
}

/**
 * The slash line, or `undefined` when this prompt is a normal turn.
 * A leading slash after trim counts. Image prompts and multi-block
 * prompts do not.
 */
export function slashLineOf(prompt: ProtocolPromptInput): string | undefined {
  let raw: string | undefined;
  if ("text" in prompt) {
    raw = prompt.text;
  } else if (
    prompt.content.length === 1 &&
    prompt.content[0]?.type === "text"
  ) {
    raw = prompt.content[0].text;
  }
  if (raw === undefined) return undefined;
  const line = raw.trim();
  if (!line.startsWith("/")) return undefined;
  return line;
}

function stateFor(agent: Agent): SlashState {
  const existing = states.get(agent);
  if (existing !== undefined) return existing;
  const cwd = typeof agent.cwd === "string" ? agent.cwd : process.cwd();
  const sandbox: PermissionMode | undefined =
    typeof agent.getPermissionMode === "function"
      ? agent.getPermissionMode()
      : "read-only";
  const created: SlashState = {
    args: acpRunArgs(cwd, sandbox),
    turns: 0,
    totalCostUsd: 0,
  };
  states.set(agent, created);
  return created;
}

/** Remember a model turn so `/status`, `/cost`, and `/copy` see it. */
export function rememberAcpTurn(
  agent: Agent,
  turn: { text?: string; costUsd: number },
): void {
  const state = stateFor(agent);
  state.turns += 1;
  state.totalCostUsd = turn.costUsd;
  if (turn.text !== undefined && turn.text.length > 0) {
    state.lastResponse = turn.text;
  }
}

function subagentsOf(
  agent: Agent,
): { list: () => ReadonlyArray<import("../subagent/types.js").SubagentRecord> } | undefined {
  if (typeof agent.getMeshSubmitter !== "function") return undefined;
  const submitter = agent.getMeshSubmitter();
  if (submitter === undefined || typeof submitter.listSubagents !== "function") {
    return undefined;
  }
  const list = submitter.listSubagents.bind(submitter);
  return { list };
}

function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      callback();
    },
  });
  return {
    stream,
    text: () => chunks.join(""),
  };
}

function joined(stdout: string, stderr: string): string {
  return [stdout.trimEnd(), stderr.trimEnd()]
    .filter((part) => part.length > 0)
    .join("\n");
}

export async function dispatchAcpSlash(input: {
  agent: Agent;
  prompt: ProtocolPromptInput;
  memoryStore?: MemoryStore;
  scoreboard?: { entries?: () => ReadonlyArray<unknown> };
}): Promise<ProtocolPromptResult | undefined> {
  const line = slashLineOf(input.prompt);
  if (line === undefined) return undefined;
  const parsed = parseCommandLine(line);
  if (parsed === null) return undefined;

  const registry = await loadRegistry();
  const state = stateFor(input.agent);
  const stdout = capture();
  const stderr = capture();
  const subagentRegistry = subagentsOf(input.agent);
  const result = await dispatchCommand(registry, parsed.name, parsed.args, {
    agent: input.agent,
    args: state.args,
    stdout: stdout.stream,
    stderr: stderr.stream,
    turns: state.turns,
    totalCostUsd: state.totalCostUsd,
    registry,
    ...(input.scoreboard !== undefined ? { scoreboard: input.scoreboard } : {}),
    ...(subagentRegistry !== undefined ? { subagentRegistry } : {}),
    ...(state.lastResponse !== undefined ? { lastResponse: state.lastResponse } : {}),
    ...(input.memoryStore !== undefined ? { memoryStore: input.memoryStore } : {}),
  });

  let text = joined(stdout.text(), stderr.text());
  if (result.kind === "exit") {
    text = SESSION_STAYS_OPEN;
  } else if (result.kind === "unknown") {
    text =
      `unknown command: ${result.name}\n` +
      "type /help for a list of commands";
  } else if (result.kind === "error") {
    const line = `error: ${result.message}`;
    text = text.length > 0 ? `${text}\n${line}` : line;
  } else if (text.length === 0) {
    text = "Done.";
  }

  const message: ProtocolCommittedMessage = { role: "assistant", text };
  return { stopReason: "end_turn", messages: [message] };
}

function acpRunArgs(
  cwd: string,
  sandbox: PermissionMode | undefined,
): RunParsedArgs {
  return {
    subcommand: "run",
    help: false,
    version: false,
    json: false,
    sandbox,
    sandboxExecutor: undefined,
    approval: undefined,
    model: undefined,
    provider: undefined,
    baseUrl: undefined,
    cwd,
    maxTurns: undefined,
    maxCostUsd: undefined,
    noSubagents: false,
    resume: undefined,
    resumeRemote: undefined,
    fork: undefined,
    persist: false,
    plugins: [],
    pluginConfigs: [],
    sessionDir: undefined,
    plan: false,
    repl: false,
    acp: true,
    peers: [],
    discovery: "static",
    peerConnectTimeoutMs: undefined,
    noColor: true,
    verbose: false,
    quiet: false,
    positional: [],
  };
}
