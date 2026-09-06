/**
 * Workspace slash handlers — git, hooks, memory, plan, session lifecycle.
 */

import type { EnvoyHarnessClient } from "@envoymesh/envoy-harness-client";

import type { SessionSink, SessionWorkspaceCtx } from "./session-context.js";

export async function newSessionImpl(s: SessionWorkspaceCtx): Promise<void> {
  if (s.busy) {
    s.push("status", "busy — /cancel first, then /new");
    return;
  }
  try {
    const created = await s.client.acpNewSession(
      s.cwd !== undefined ? { cwd: s.cwd } : undefined,
    );
    s.sessionId = created.sessionId;
    if (s.initialAutoRun !== undefined) {
      try {
        await s.client.setSessionPolicy(created.sessionId, {
          autoRun: s.initialAutoRun,
        });
      } catch {
        // Best-effort.
      }
    }
    s.lines.length = 0;
    s.turnSeen.clear();
    s.lastTurnCostUsd = undefined;
    s.onTranscript?.(s.lines);
    s.push("system", `new session ${created.sessionId}`);
  } catch (err) {
    s.push("status", `new session failed: ${(err as Error).message}`);
  }
}

export async function showGitDiffImpl(
  s: SessionSink,
  staged?: boolean,
  stat?: boolean,
): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  try {
    const out = await s.client.gitDiff(s.sessionId, {
      ...(staged === true ? { staged: true } : {}),
      ...(stat === true ? { stat: true } : {}),
    });
    s.push("status", `Git diff\n${out}`);
  } catch (err) {
    s.push("status", `git diff failed: ${(err as Error).message}`);
  }
}

export async function showGitStatusImpl(s: SessionSink): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  try {
    const out = await s.client.gitStatus(s.sessionId);
    s.push("status", `Git status\n${out}`);
  } catch (err) {
    s.push("status", `git status failed: ${(err as Error).message}`);
  }
}

export async function showHooksImpl(s: SessionSink): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  try {
    const hooks = await s.client.listSessionHooks(s.sessionId);
    if (hooks.length === 0) {
      s.push("status", "Hooks (0)");
      return;
    }
    const lines = hooks.map(
      (h) => `  ${h.event.padEnd(20)}  ${h.handlerCount} handler(s)`,
    );
    s.push("status", `Hooks (${hooks.length})\n${lines.join("\n")}`);
  } catch (err) {
    s.push("status", `hooks failed: ${(err as Error).message}`);
  }
}

export async function showMcpImpl(s: SessionSink): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  try {
    const servers = await s.client.listSessionMcp(s.sessionId);
    if (servers.length === 0) {
      s.push("status", "MCP (0 servers)");
      return;
    }
    s.push(
      "status",
      `MCP (${servers.length})\n${servers.map((srv) => `  - ${srv}`).join("\n")}`,
    );
  } catch (err) {
    s.push("status", `mcp failed: ${(err as Error).message}`);
  }
}

export async function showAgentsImpl(s: SessionSink): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  try {
    const out = await s.client.listSessionAgents(s.sessionId);
    s.push("status", out);
  } catch (err) {
    s.push("status", `agents failed: ${(err as Error).message}`);
  }
}

export async function runMemoryImpl(
  s: SessionSink,
  op: "list" | "read" | "add",
  name?: string,
  body?: string,
): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  try {
    const out = await s.client.sessionMemory(s.sessionId, op, {
      ...(name !== undefined ? { name } : {}),
      ...(body !== undefined ? { body } : {}),
    });
    s.push("status", out);
  } catch (err) {
    s.push("status", `memory failed: ${(err as Error).message}`);
  }
}

export async function runPlanImpl(
  s: SessionSink,
  action: string,
  text?: string,
  reason?: string,
): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  if (s.busy && action !== "show") {
    s.push("status", "busy — /cancel first");
    return;
  }
  try {
    const out = await s.client.sessionPlan(s.sessionId, action, {
      ...(text !== undefined ? { text } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
    s.push("status", out);
  } catch (err) {
    s.push("status", `plan failed: ${(err as Error).message}`);
  }
}

export async function runModeImpl(
  s: SessionSink,
  mode?: "default" | "plan" | "review",
): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  if (s.busy) {
    s.push("status", "busy — /cancel first");
    return;
  }
  try {
    const next = await s.client.setCollaborationMode(s.sessionId, mode);
    s.push("status", `collaboration mode: ${next}`);
  } catch (err) {
    s.push("status", `mode failed: ${(err as Error).message}`);
  }
}

export async function runReviewImpl(
  s: SessionSink,
  staged?: boolean,
): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  if (s.busy) {
    s.push("status", "busy — /cancel first");
    return;
  }
  s.push("status", "reviewing…");
  try {
    const out = await s.client.sessionReview(
      s.sessionId,
      staged === true,
    );
    s.push("status", `Review\n${out}`);
  } catch (err) {
    s.push("status", `review failed: ${(err as Error).message}`);
  }
}

export async function runInitImpl(s: SessionSink): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  if (s.busy) {
    s.push("status", "busy — /cancel first");
    return;
  }
  s.push("status", "generating AGENTS.md…");
  try {
    const out = await s.client.sessionInit(s.sessionId);
    s.push("status", out);
  } catch (err) {
    s.push("status", `init failed: ${(err as Error).message}`);
  }
}

/** U6 — resume a persisted session (`session/load`). */
export async function resumeSessionImpl(
  s: SessionWorkspaceCtx,
  sessionId: string,
): Promise<void> {
  if (s.busy) {
    s.push("status", "busy — /cancel first");
    return;
  }
  try {
    const loaded = await s.client.loadSession(sessionId, s.cwd);
    s.sessionId = loaded.sessionId;
    s.lines.length = 0;
    s.turnSeen.clear();
    s.lastTurnCostUsd = undefined;
    s.onTranscript?.(s.lines);
    s.push("system", `resumed session ${loaded.sessionId}`);
  } catch (err) {
    s.push("status", `resume failed: ${(err as Error).message}`);
  }
}

/** U6a.5 — persisted sessions for resume picker (`sessions/list`). */
export async function listPersistedSessionsImpl(
  client: EnvoyHarnessClient,
): Promise<Awaited<ReturnType<EnvoyHarnessClient["listSessions"]>>> {
  try {
    return await client.listSessions();
  } catch {
    return [];
  }
}

/** U6 — plan tab body. */
export async function fetchPlanViewImpl(s: SessionSink): Promise<string> {
  if (s.sessionId === undefined) return "";
  return await s.client.sessionPlan(s.sessionId, "show");
}

/** U6 — memory tab body. */
export async function fetchMemoryViewImpl(s: SessionSink): Promise<string> {
  if (s.sessionId === undefined) return "";
  return await s.client.sessionMemory(s.sessionId, "list");
}

/** U6 — git diff tab body. */
export async function fetchGitDiffViewImpl(
  s: SessionWorkspaceCtx,
): Promise<string> {
  if (s.sessionId === undefined) return "";
  return await s.client.gitDiff(s.sessionId, {
    ...(s.gitDiffStaged ? { staged: true } : {}),
    ...(s.gitDiffStat ? { stat: true } : {}),
  });
}

export function setGitDiffFlagsImpl(
  s: SessionWorkspaceCtx,
  staged?: boolean,
  stat?: boolean,
): void {
  s.gitDiffStaged = staged === true;
  s.gitDiffStat = stat === true;
}
