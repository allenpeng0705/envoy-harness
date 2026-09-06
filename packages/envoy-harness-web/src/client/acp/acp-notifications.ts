/**
 * Parse ACP session notifications into transcript actions.
 * Wire shapes match packages/envoy-harness ACP server:
 *   session/update → { sessionId, message: { role, text, partial? } }
 *   session/token  → { sessionId, token: { role, delta } }
 */

export type TranscriptRole = "user" | "assistant" | "system" | "tool" | "status";

export interface TranscriptRow {
  role: TranscriptRole;
  text: string;
}

function asRecord(params: unknown): Record<string, unknown> | undefined {
  if (params === null || typeof params !== "object") return undefined;
  return params as Record<string, unknown>;
}

function sessionMatches(
  params: Record<string, unknown>,
  sessionId: string | null,
): boolean {
  const sid = params["sessionId"];
  if (typeof sid !== "string") return true;
  if (sessionId === null) return true;
  return sid === sessionId;
}

/** Extract assistant text delta from `session/token`, or undefined. */
export function parseSessionTokenDelta(
  params: unknown,
  sessionId: string | null,
): string | undefined {
  const p = asRecord(params);
  if (p === undefined || !sessionMatches(p, sessionId)) return undefined;
  const token = p["token"];
  if (token === null || typeof token !== "object") return undefined;
  const t = token as Record<string, unknown>;
  if (t["role"] !== "assistant") return undefined;
  const delta = t["delta"];
  if (typeof delta !== "string" || delta.length === 0) return undefined;
  return delta;
}

/**
 * Extract a committed transcript row from `session/update`.
 * Ignores user/system/status (host already owns those).
 */
export function parseSessionUpdateMessage(
  params: unknown,
  sessionId: string | null,
): TranscriptRow | undefined {
  const p = asRecord(params);
  if (p === undefined || !sessionMatches(p, sessionId)) return undefined;
  const message = p["message"];
  if (message === null || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  if (typeof m["text"] !== "string" || m["text"].length === 0) return undefined;
  const raw = m["role"];
  if (raw === "user" || raw === "system" || raw === "status") return undefined;
  const role: TranscriptRole =
    raw === "assistant" || raw === "tool" ? raw : "assistant";
  return { role, text: m["text"] };
}

/**
 * Rows from `session/prompt` result that belong in the UI transcript.
 * Skips the echoed user prompt; keeps assistant/tool/system.
 */
export function rowsFromPromptResult(
  messages: Array<{ role?: string; text?: string }> | undefined,
): TranscriptRow[] {
  if (messages === undefined) return [];
  const out: TranscriptRow[] = [];
  for (const m of messages) {
    if (typeof m.text !== "string" || m.text.length === 0) continue;
    if (m.role === "user") continue;
    if (m.role === "assistant" || m.role === "tool" || m.role === "system") {
      out.push({ role: m.role, text: m.text });
    } else if (m.role === undefined) {
      out.push({ role: "assistant", text: m.text });
    }
  }
  return out;
}

/**
 * Merge prompt-result rows into an existing message list without duplicates.
 * Assistant rows replace the trailing assistant bubble when present.
 */
export function mergePromptRows(
  existing: ReadonlyArray<{ role: TranscriptRole; text: string }>,
  rows: ReadonlyArray<TranscriptRow>,
): TranscriptRow[] {
  const next = existing.map((m) => ({ role: m.role, text: m.text }));
  for (const row of rows) {
    if (row.role === "assistant") {
      const last = next[next.length - 1];
      if (last !== undefined && last.role === "assistant") {
        last.text = row.text;
      } else {
        next.push(row);
      }
      continue;
    }
    const dup = next.some((m) => m.role === row.role && m.text === row.text);
    if (!dup) next.push(row);
  }
  return next;
}
