/**
 * Info / status display helpers for slash commands.
 */

import type { SessionSink, SessionWorkspaceCtx } from "./session-context.js";

/** R3 — list tools (`tools/list`). */
export async function showToolsImpl(s: SessionSink): Promise<void> {
  let tools;
  try {
    tools = await s.client.listTools();
  } catch (err) {
    s.push("status", `tools unavailable: ${(err as Error).message}`);
    return;
  }
  if (tools.length === 0) {
    s.push("status", "Tools (0)");
    return;
  }
  const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
  s.push("status", `Tools (${tools.length})\n${lines.join("\n")}`);
}

/** Show harness config (`config/get`). */
export async function showConfigImpl(s: SessionSink): Promise<void> {
  try {
    const config = await s.client.getConfig();
    const lines = Object.entries(config).map(([k, v]) => `- ${k}: ${String(v)}`);
    s.push(
      "status",
      lines.length > 0 ? `Config\n${lines.join("\n")}` : "Config (empty)",
    );
  } catch (err) {
    s.push("status", `config unavailable: ${(err as Error).message}`);
  }
}

export function showSessionInfoImpl(s: SessionWorkspaceCtx): void {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  s.push(
    "status",
    `Session ${s.sessionId}\n  messages: ${s.lines.length}\n  busy: ${s.busy}`,
  );
}

export async function showStatusImpl(
  s: SessionWorkspaceCtx,
  getModelLabel: () => Promise<string | undefined>,
): Promise<void> {
  const model = await getModelLabel();
  const parts = [
    `session: ${s.sessionId ?? "—"}`,
    `busy: ${s.busy}`,
    `transcript lines: ${s.lines.length}`,
    ...(model !== undefined ? [`model: ${model}`] : []),
    ...(s.lastTurnCostUsd !== undefined
      ? [`last turn cost: $${s.lastTurnCostUsd.toFixed(4)}`]
      : []),
  ];
  s.push("status", `Status\n  ${parts.join("\n  ")}`);
}

export function showCostImpl(s: SessionWorkspaceCtx): void {
  if (s.lastTurnCostUsd === undefined) {
    s.push("status", "Cost — no completed turn yet (run a prompt first)");
    return;
  }
  s.push("status", `Last turn cost: $${s.lastTurnCostUsd.toFixed(4)}`);
}

export function clearTranscriptImpl(s: SessionWorkspaceCtx): void {
  s.lines.length = 0;
  s.onTranscript?.(s.lines);
  s.push("status", "transcript cleared (agent session unchanged)");
}

/** Transcript footprint (display only — agent memory unchanged). */
export function showContextImpl(s: SessionWorkspaceCtx): void {
  const byRole = new Map<string, number>();
  for (const line of s.lines) {
    byRole.set(line.role, (byRole.get(line.role) ?? 0) + 1);
  }
  const parts = [
    `session: ${s.sessionId ?? "—"}`,
    `transcript lines: ${s.lines.length}`,
    ...[...byRole.entries()].map(([role, n]) => `${role}: ${n}`),
    ...(s.lastTurnCostUsd !== undefined
      ? [`last turn cost: $${s.lastTurnCostUsd.toFixed(4)}`]
      : []),
  ];
  s.push("status", `Context\n  ${parts.join("\n  ")}`);
}

export function showModelUsageImpl(s: SessionSink): void {
  s.push(
    "status",
    "Model swap: use /provider <openai|anthropic|deepseek|ollama> [model-id]\n" +
      "Example: /provider deepseek deepseek-chat",
  );
}
