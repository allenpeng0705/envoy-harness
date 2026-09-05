/**
 * R4.2 — retained context across compaction.
 *
 * Codex/Guardian-style: explicit size-capped facts (user answers,
 * verified notes) that survive drop-oldest / summarize / budget
 * compaction and are re-injected into the transcript.
 */

import { estimateMessageTokens } from "./budget.js";
import type { Message } from "../tools/types.js";

export type RetainedKind = "user_answer" | "fact" | "note";

export interface RetainedFragment {
  readonly id: string;
  readonly text: string;
  readonly kind: RetainedKind;
  readonly createdAt: string;
  readonly estimatedTokens: number;
}

export interface AddRetainedOptions {
  text: string;
  kind?: RetainedKind;
  id?: string;
}

export interface RetainedContextStoreOptions {
  /** Soft token budget for the whole store. Default 4_000. */
  tokenBudget?: number;
}

const DEFAULT_TOKEN_BUDGET = 4_000;

function estimateTextTokens(text: string): number {
  return estimateMessageTokens({
    role: "user",
    content: [{ type: "text", text }],
  });
}

/**
 * In-memory retained fragment list. Oldest items drop when the
 * token budget is exceeded (FIFO eviction).
 */
export class RetainedContextStore {
  private readonly items: RetainedFragment[] = [];
  private readonly tokenBudget: number;
  private seq = 0;

  constructor(options: RetainedContextStoreOptions = {}) {
    this.tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  }

  add(options: AddRetainedOptions): RetainedFragment {
    const text = options.text.trim();
    if (text.length === 0) {
      throw new Error("retained fragment text must be non-empty");
    }
    const kind = options.kind ?? "note";
    const id = options.id ?? `retained-${++this.seq}`;
    const fragment: RetainedFragment = {
      id,
      text,
      kind,
      createdAt: new Date().toISOString(),
      estimatedTokens: estimateTextTokens(text),
    };
    this.items.push(fragment);
    this.evictToBudget();
    return fragment;
  }

  list(): ReadonlyArray<RetainedFragment> {
    return this.items.slice();
  }

  clear(): void {
    this.items.length = 0;
  }

  estimatedTokens(): number {
    return this.items.reduce((n, i) => n + i.estimatedTokens, 0);
  }

  /** Stable prompt text for injection (empty when nothing retained). */
  render(): string {
    if (this.items.length === 0) return "";
    const body = this.items
      .map((i) => `- [${i.kind}] ${i.text}`)
      .join("\n");
    return `RETAINED CONTEXT (survives compaction):\n${body}`;
  }

  private evictToBudget(): void {
    while (
      this.items.length > 0 &&
      this.estimatedTokens() > this.tokenBudget
    ) {
      this.items.shift();
    }
  }
}

/**
 * Insert retained context after the system message (if any),
 * replacing any prior retained user block with the same marker.
 */
export function injectRetainedContext(
  messages: ReadonlyArray<Message>,
  store: RetainedContextStore,
): Message[] {
  const text = store.render();
  const withoutPrior = messages.filter(
    (m) =>
      !(
        m.role === "user" &&
        m.content.length === 1 &&
        m.content[0]?.type === "text" &&
        m.content[0].text.startsWith("RETAINED CONTEXT")
      ),
  );
  if (text.length === 0) {
    return withoutPrior.slice();
  }
  const retained: Message = {
    role: "user",
    content: [{ type: "text", text }],
  };
  if (withoutPrior.length > 0 && withoutPrior[0]!.role === "system") {
    return [withoutPrior[0]!, retained, ...withoutPrior.slice(1)];
  }
  return [retained, ...withoutPrior];
}
