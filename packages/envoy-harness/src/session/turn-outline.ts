/**
 * R4.4 — session turn outline / projection.
 *
 * Cheap turn-rail data without replaying the full transcript in the UI.
 * A turn starts at each `user` message and includes following assistant /
 * tool / system messages until the next user (or EOF).
 */

import { promises as fs } from "node:fs";

import type { ContentBlock, Message, Role } from "../tools/types.js";

export interface TurnOutlineEntry {
  /** 0-based turn index. */
  turnIndex: number;
  /** Inclusive message index (0 = first message after header). */
  startMessageIndex: number;
  /** Inclusive end message index. */
  endMessageIndex: number;
  /** Count of `tool_call` blocks in assistant messages in this turn. */
  toolCallCount: number;
  /** First ~80 chars of the user text that opened the turn. */
  userPreview: string;
  /** Distinct tool names seen in this turn (registration order). */
  toolNames: readonly string[];
}

export interface TurnOutline {
  sessionId: string;
  turns: readonly TurnOutlineEntry[];
}

const PREVIEW_MAX = 80;

function countToolCalls(content: ReadonlyArray<ContentBlock>): {
  count: number;
  names: string[];
} {
  const names: string[] = [];
  let count = 0;
  for (const b of content) {
    if (b.type === "tool_call") {
      count += 1;
      if (!names.includes(b.name)) names.push(b.name);
    }
  }
  return { count, names };
}

function userPreviewFromContent(content: ReadonlyArray<ContentBlock>): string {
  for (const b of content) {
    if (b.type === "text" && b.text.trim().length > 0) {
      const t = b.text.trim().replace(/\s+/g, " ");
      return t.length <= PREVIEW_MAX ? t : `${t.slice(0, PREVIEW_MAX - 1)}…`;
    }
  }
  return "";
}

/**
 * Full-replay reference: build an outline from an in-memory message list.
 */
export function buildTurnOutlineFromMessages(
  sessionId: string,
  messages: ReadonlyArray<Message>,
): TurnOutline {
  const turns: TurnOutlineEntry[] = [];
  let current: {
    turnIndex: number;
    startMessageIndex: number;
    endMessageIndex: number;
    toolCallCount: number;
    userPreview: string;
    toolNames: string[];
  } | null = null;

  const flush = () => {
    if (current === null) return;
    turns.push({
      turnIndex: current.turnIndex,
      startMessageIndex: current.startMessageIndex,
      endMessageIndex: current.endMessageIndex,
      toolCallCount: current.toolCallCount,
      userPreview: current.userPreview,
      toolNames: [...current.toolNames],
    });
    current = null;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      flush();
      current = {
        turnIndex: turns.length,
        startMessageIndex: i,
        endMessageIndex: i,
        toolCallCount: 0,
        userPreview: userPreviewFromContent(msg.content),
        toolNames: [],
      };
      continue;
    }
    if (current === null) {
      // Leading non-user messages (rare) — fold into a synthetic turn 0
      // starting at this index once we see them? Skip until first user
      // so outline only covers user-started turns.
      continue;
    }
    current.endMessageIndex = i;
    const { count, names } = countToolCalls(msg.content);
    current.toolCallCount += count;
    for (const n of names) {
      if (!current.toolNames.includes(n)) current.toolNames.push(n);
    }
  }
  flush();
  return { sessionId, turns };
}

/**
 * Incremental projector: feed messages in order; snapshot matches
 * {@link buildTurnOutlineFromMessages} for the same sequence.
 */
export class TurnOutlineRegistry {
  private readonly sessionId: string;
  private readonly messages: Message[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Append one transcript message (same order as the JSONL file). */
  appendMessage(message: Message): void {
    this.messages.push({
      role: message.role,
      content: [...message.content],
    });
  }

  /** Convenience for role + content. */
  append(role: Role, content: ReadonlyArray<ContentBlock>): void {
    this.appendMessage({ role, content: [...content] });
  }

  snapshot(): TurnOutline {
    return buildTurnOutlineFromMessages(this.sessionId, this.messages);
  }

  /** Message count fed so far. */
  size(): number {
    return this.messages.length;
  }
}

/**
 * Cold-start: load a JSONL session file and project a turn outline.
 * Skips the header line; corrupt message lines throw.
 */
export async function loadTurnOutlineFromFile(
  filePath: string,
): Promise<TurnOutline> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error(`empty session file: ${filePath}`);
  }
  const header = JSON.parse(lines[0]!) as {
    _kind?: string;
    id?: string;
  };
  if (header._kind !== "header" || typeof header.id !== "string") {
    throw new Error(`missing or invalid header: ${filePath}`);
  }
  const registry = new TurnOutlineRegistry(header.id);
  for (let i = 1; i < lines.length; i++) {
    const msg = JSON.parse(lines[i]!) as Message;
    if (typeof msg.role !== "string" || !Array.isArray(msg.content)) {
      throw new Error(`invalid message at line ${i + 1} in ${filePath}`);
    }
    registry.appendMessage(msg);
  }
  return registry.snapshot();
}
