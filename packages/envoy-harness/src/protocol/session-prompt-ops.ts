/**
 * The two heavy session operations: running a prompt turn, and compacting a
 * transcript.
 *
 * **Why they live here.** `agent-backend.ts` sat against the module-size cap
 * (787/800), leaving no room for backend logic; these two were 158 and 48
 * lines of it. Both are self-contained given a `LiveSession`: they do not
 * touch the session map, the lease, or the model/policy setters, so they read
 * the same from here. The backend keeps the lookup, the idle assertion, and
 * the option wiring, and delegates.
 */

import type { MemoryStore } from "../memories/store.js";
import type { Agent, AgentResult } from "../agent.js";
import type { Tracer } from "../trace/types.js";
import { hasTurnHints } from "../interaction/turn-hints.js";
import { stripThinking } from "../util/strip-thinking.js";
import { traceEventToActivity } from "./activity-format.js";
import { traceEventToCommittedMessage } from "./message-format.js";
import { dispatchAcpSlash, rememberAcpTurn } from "./slash-dispatch.js";
import { summarizeDroppedMessages } from "./session-ops.js";
import { cancelPendingUserQuestions, type LiveSession } from "./agent-backend-host.js";
import type {
  ProtocolCommittedMessage,
  ProtocolCompactResult,
  ProtocolPromptInput,
  ProtocolPromptResult,
  ProtocolScoreboardEntry,
  ProtocolSessionBackend,
} from "./session-backend.js";

/** Kept turns when `compact` is called without `keep` or `budget`. */
const DEFAULT_COMPACT_KEEP = 20;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
      ) {
        return (b as { text: string }).text;
      }
      return "";
    })
    .filter((t) => t.length > 0)
    .join("\n");
}

function promptToUserBlocks(
  prompt: ProtocolPromptInput,
): Array<
  { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
> {
  if ("text" in prompt) {
    return [{ type: "text", text: prompt.text }];
  }
  return [...prompt.content];
}

function truncateActivity(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length === 0) return "";
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

/** Wiring the prompt turn needs from the backend's options. */
export interface SessionPromptDeps {
  memoryStore?: MemoryStore;
  scoreboardSummary?: () => ReadonlyArray<ProtocolScoreboardEntry>;
}

/**
 * Run one prompt turn against a live session.
 *
 * A leading `/` is a REPL command rather than a model turn, so it is
 * dispatched before the turn machinery (and returns early). Everything else:
 * forward the agent's trace/stream/tool-output sinks to the caller's
 * callbacks, run the turn, and report only the messages this turn produced.
 */
export async function runSessionPrompt(
  live: LiveSession,
  params: Parameters<NonNullable<ProtocolSessionBackend["prompt"]>>[0],
  deps: SessionPromptDeps,
): Promise<ProtocolPromptResult> {
  // A leading `/` is a REPL command, not a model turn.
  const slash = await dispatchAcpSlash({
    agent: live.agent,
    prompt: params.prompt,
    ...(deps.memoryStore !== undefined
      ? { memoryStore: deps.memoryStore }
      : {}),
    ...(deps.scoreboardSummary !== undefined
      ? { scoreboard: { entries: () => deps.scoreboardSummary!() } }
      : {}),
  });
  if (slash !== undefined) {
    const message = slash.messages[0];
    if (message !== undefined) params.onUpdate?.(message);
    return slash;
  }
  live.requestPermission = params.requestPermission;
  live.requestUserQuestion =
    params.requestUserQuestion !== undefined
      ? async (req) => {
          const raw = await params.requestUserQuestion!(req);
          return {
            value: typeof raw.value === "string" ? raw.value : "",
            ...(typeof raw.optionIndex === "number"
              ? { optionIndex: raw.optionIndex }
              : {}),
            ...(Array.isArray(raw.optionIndexes) && raw.optionIndexes.length > 0
              ? { optionIndexes: raw.optionIndexes }
              : {}),
            cancelled: raw.cancelled === true,
            ...(raw.cancelled === true
              ? { cancelledReason: "aborted" as const }
              : {}),
          };
        }
      : undefined;
  const ac = new AbortController();
  live.abort = ac;
  const onAbort = (): void => {
    live.agent.assistantStreamSink = undefined;
    live.agent.toolOutputSink = undefined;
    ac.abort();
    live.permissionWait?.resolve("deny");
    live.permissionWait = undefined;
    cancelPendingUserQuestions(live);
    // Agent.run() polls abortController; cancel must abort the Agent,
    // not only a local controller that nothing observes.
    live.agent.abort("session cancelled");
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  // Only return / notify messages produced by this turn.
  // Prefer getMessageCount() so hermetic mocks need not expose session.
  const priorCount =
    typeof live.agent.getMessageCount === "function"
      ? live.agent.getMessageCount()
      : (live.agent.session?.messages.length ?? 0);
  const priorTracer = live.agent.tracer;
  const touchedFiles: string[] = [];
  const forwardTracer: Tracer = {
    emit: (event) => {
      priorTracer.emit(event);
      if (event.kind === "tool_call") {
        const args = event.call.args as Record<string, unknown>;
        if (event.call.name === "write" || event.call.name === "edit") {
          const path =
            typeof args.path === "string" && args.path.length > 0
              ? args.path
              : undefined;
          if (path !== undefined && !touchedFiles.includes(path)) {
            touchedFiles.push(path);
          }
        }
      }
      if (params.onActivity !== undefined) {
        const activity = traceEventToActivity(event);
        if (event.kind === "agent_end" && touchedFiles.length > 0) {
          activity.summary = `${activity.summary} · changed: ${touchedFiles.join(", ")}`;
        }
        params.onActivity(activity);
      }
      const committed = traceEventToCommittedMessage(event);
      if (committed !== undefined) {
        params.onUpdate?.(committed);
      }
    },
  };
  live.agent.tracer = forwardTracer;
  live.agent.assistantStreamSink = (delta) => {
    if (params.signal.aborted || ac.signal.aborted) return;
    params.onToken?.({ role: "assistant", delta });
  };
  live.agent.toolOutputSink = (info) => {
    if (params.signal.aborted || ac.signal.aborted) return;
    if (params.onActivity === undefined) return;
    const summary = truncateActivity(info.stdout, 120);
    if (summary.length === 0) return;
    params.onActivity({
      kind: "tool_progress",
      ts: new Date().toISOString(),
      toolName: info.toolName,
      toolCallId: info.callId,
      summary,
    });
  };
  try {
    const result: AgentResult = await live.agent.run(
      promptToUserBlocks(params.prompt),
    );
    const turnMessages = result.messages.slice(priorCount);
    const messages: ProtocolCommittedMessage[] = [];
    for (const m of turnMessages) {
      const raw = messageText(m.content);
      const text = m.role === "assistant" ? stripThinking(raw) : raw;
      if (text.length === 0) continue;
      const role = m.role as ProtocolCommittedMessage["role"];
      const msg: ProtocolCommittedMessage = { role, text };
      messages.push(msg);
      params.onUpdate?.(msg);
    }
    const stopReason = params.signal.aborted ? "cancelled" : result.stopReason;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const costUsd =
      typeof live.agent.getCost === "function" ? live.agent.getCost().costUsd : 0;
    rememberAcpTurn(live.agent, {
      ...(lastAssistant !== undefined ? { text: lastAssistant.text } : {}),
      costUsd,
    });
    return {
      stopReason,
      messages,
      ...(result.turnHints !== undefined && hasTurnHints(result.turnHints)
        ? { turnHints: result.turnHints }
        : {}),
    };
  } finally {
    live.agent.tracer = priorTracer;
    live.agent.assistantStreamSink = undefined;
    live.agent.toolOutputSink = undefined;
    params.signal.removeEventListener("abort", onAbort);
    live.abort = undefined;
    live.permissionWait = undefined;
    live.requestPermission = undefined;
    live.requestUserQuestion = undefined;
    cancelPendingUserQuestions(live);
  }
}

/**
 * Compact a session's transcript, by explicit budget or by keeping N turns.
 *
 * Awaiting `flushSession()` before reporting success is deliberate: the swap
 * is atomic, but "atomic" only means the OLD transcript survives a crash —
 * not that the compaction does. A client that compacts and immediately
 * disconnects would otherwise see the pre-compaction history back on
 * `--resume` with no indication anything was lost.
 *
 * A failed *summary* must not degrade to drop-oldest: that would destroy the
 * oldest part of the conversation with no replacement.
 */
export async function runSessionCompact(
  live: LiveSession,
  params: Parameters<NonNullable<ProtocolSessionBackend["compact"]>>[0],
): Promise<ProtocolCompactResult> {
  const before = live.agent.getMessageCount();
  if (params.budget !== undefined) {
    const r = live.agent.compactWithBudget(params.budget);
    await live.agent.flushSession();
    const after = live.agent.getMessageCount();
    return {
      messageCountBefore: before,
      messageCountAfter: after,
      droppedCount: r.droppedCount,
      totalTokensAfter: r.totalTokensAfter,
      overBudget: r.overBudget,
    };
  }
  const keep = params.keep ?? DEFAULT_COMPACT_KEEP;
  if (params.summarize === true) {
    await live.agent.compactWithSummary(keep, (dropped) =>
      summarizeDroppedMessages(live.agent as Agent, dropped),
    );
    const after = live.agent.getMessageCount();
    return {
      messageCountBefore: before,
      messageCountAfter: after,
      droppedCount: Math.max(0, before - after),
      summarized: true,
    };
  }
  live.agent.compact(keep);
  await live.agent.flushSession();
  const after = live.agent.getMessageCount();
  return {
    messageCountBefore: before,
    messageCountAfter: after,
    droppedCount: Math.max(0, before - after),
  };
}
