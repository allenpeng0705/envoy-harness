/**
 * Session policy and compaction slash handlers.
 */

import type { SessionSink } from "./session-context.js";

export async function runCompactImpl(
  s: SessionSink,
  keep?: number,
  budget?: number,
  summarize?: boolean,
): Promise<void> {
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  if (s.busy) {
    s.push("status", "busy — /cancel first");
    return;
  }
  if (summarize === true) {
    s.push("status", "summarizing transcript…");
  }
  try {
    const r = await s.client.compactSession(s.sessionId, {
      ...(keep !== undefined ? { keep } : {}),
      ...(budget !== undefined ? { budget } : {}),
      ...(summarize === true ? { summarize: true } : {}),
    });
    const note =
      r.overBudget === true
        ? " (over budget)"
        : r.summarized === false && summarize === true
          ? " (summarize failed — drop-oldest fallback)"
          : r.summarized === true
            ? " (with LLM summary)"
            : "";
    const tokens =
      r.totalTokensAfter !== undefined
        ? `, ${r.totalTokensAfter} tokens`
        : "";
    s.push(
      "status",
      `Compacted: ${r.messageCountBefore} → ${r.messageCountAfter} messages (dropped ${r.droppedCount}${tokens})${note}`,
    );
  } catch (err) {
    s.push("status", `compact failed: ${(err as Error).message}`);
  }
}

export async function runSetProviderImpl(
  s: SessionSink,
  name: string,
  model?: string,
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
    const r = await s.client.setSessionModel(s.sessionId, name, model);
    s.push(
      "status",
      `provider: ${r.provider}${r.model !== undefined ? ` model=${r.model}` : ""}`,
    );
  } catch (err) {
    s.push("status", `provider swap failed: ${(err as Error).message}`);
  }
}

export async function runSetSandboxImpl(
  s: SessionSink,
  mode: string,
): Promise<void> {
  const valid = new Set([
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]);
  if (!valid.has(mode)) {
    s.push("status", `invalid sandbox: ${mode}`);
    return;
  }
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  if (s.busy) {
    s.push("status", "busy — /cancel first");
    return;
  }
  try {
    await s.client.setSessionPolicy(s.sessionId, {
      sandbox: mode as "read-only" | "workspace-write" | "danger-full-access",
    });
    s.push("status", `sandbox: ${mode}`);
  } catch (err) {
    s.push("status", `sandbox failed: ${(err as Error).message}`);
  }
}

export async function runSetApprovalImpl(
  s: SessionSink,
  mode: string,
): Promise<void> {
  const valid = new Set([
    "unless-trusted",
    "on-request",
    "granular",
    "never",
  ]);
  if (!valid.has(mode)) {
    s.push("status", `invalid approval: ${mode}`);
    return;
  }
  if (s.sessionId === undefined) {
    s.push("status", "no active session");
    return;
  }
  if (s.busy) {
    s.push("status", "busy — /cancel first");
    return;
  }
  try {
    await s.client.setSessionPolicy(s.sessionId, {
      approval: mode as "unless-trusted" | "on-request" | "granular" | "never",
    });
    s.push("status", `approval: ${mode}`);
  } catch (err) {
    s.push("status", `approval failed: ${(err as Error).message}`);
  }
}

export async function runSetAutoRunImpl(
  s: SessionSink,
  mode: "safe-only" | "always-confirm" | "off" | undefined,
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
    if (mode === undefined) {
      const policy = await s.client.getSessionPolicy(s.sessionId);
      const autoRun = policy.autoRun ?? "unset (host default)";
      const label =
        autoRun === "off"
          ? "always approve"
          : autoRun === "always-confirm"
            ? "always ask"
            : autoRun === "safe-only"
              ? "default (auto-run safe)"
              : autoRun;
      s.push(
        "status",
        `permissions: ${label} · sandbox: ${policy.sandbox ?? "?"} · approval: ${policy.approval ?? "?"}`,
      );
      return;
    }
    await s.client.setSessionPolicy(s.sessionId, { autoRun: mode });
    const label =
      mode === "safe-only"
        ? "default (auto-run safe)"
        : mode === "always-confirm"
          ? "always ask"
          : "always approve";
    s.push("status", `permissions: ${label}`);
  } catch (err) {
    s.push("status", `permissions failed: ${(err as Error).message}`);
  }
}
