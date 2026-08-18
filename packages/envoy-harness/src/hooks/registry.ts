/**
 * HookRegistry — the in-memory store of hook handlers.
 *
 * **Design doc:** `docs/design.md` §8.2.
 *
 * **Three layers of composition (in order):**
 *
 * 1. **Middlewares** (added via `use()`). Run first; can short-circuit
 *    by returning `block`. Useful for cross-cutting concerns:
 *    audit logging, rate limiting, debug traces.
 *
 * 2. **Handlers** (added via `on()`). Matched against the event payload
 *    by `matchHandler`. Matched handlers run in registration order.
 *    First `block` wins; otherwise, all `add-context` are concatenated;
 *    otherwise, last `modify` wins (PostToolUse only); otherwise,
 *    `continue`.
 *
 * 3. **Default** — if no handler fires, return `continue`. The
 *    orchestrator proceeds.
 *
 * **`on()` accepts two forms:**
 * - A function (`HookFn`) — in-process handler. Most common.
 * - A `HookHandler` object — declarative; runs a shell command or
 *   imports a TS module. Useful for config-driven hooks.
 *
 * **Stability:** the public API is `on`, `use`, `fire`, `unregister`,
 * `clear`. New decision kinds require a schema version bump; new
 * matchers are additive.
 */

import type {
  HookDecision,
  HookEvent,
  HookEventName,
  HookFn,
  HookHandler,
} from "../types.js";

/** A middleware runs before handlers and can short-circuit. */
export type HookMiddleware = (
  eventName: HookEventName,
  payload: unknown,
) => Promise<HookDecision>;

/**
 * Optional payload shape that handlers/middlewares can assume.
 * The actual payload is event-specific (see §8.1); this is just
 * the common fields a `match.tool` / `match.pattern` checks.
 */
interface PayloadWithTool {
  tool?: string;
  [key: string]: unknown;
}

/**
 * Internal normalized form. Each registered handler is stored with
 * its original input (for unregister) and a resolved `run` function
 * (for fire). This lets `on()` accept either a `HookFn` or a
 * declarative `HookHandler` while keeping a single internal type.
 */
interface StoredHandler {
  /** Original argument passed to `on()`. Used by `unregister`. */
  input: HookFn | HookHandler;
  /** Normalized matcher. `undefined` means match all. */
  match: { tool?: string; pattern?: string } | undefined;
  /** Normalized run function. Always set at registration time. */
  run: HookFn;
}

/** Decide if a value is a function (`HookFn`) or a declarative object. */
function isHookFn(value: HookFn | HookHandler): value is HookFn {
  return typeof value === "function";
}

/**
 * Convert a declarative `HookHandler` (shell command or module path)
 * into a `HookFn`. The returned function delegates to
 * `runShellHandler` / `runModuleHandler` lazily (imported on first
 * call) so the registry tree-shakes unused runners.
 *
 * **Synchronous wrapper, async body:** the returned `HookFn` is a
 * closure that captures the handler's command/module/timeoutMs.
 * The first invocation triggers the dynamic import; subsequent
 * invocations reuse the cached module reference.
 */
function declarativeToFn(handler: HookHandler): HookFn {
  if (handler.command) {
    return async (event: HookEvent) => {
      const { runShellHandler } = await import("./runner.js");
      return runShellHandler(
        handler.command as string,
        event.name,
        event.payload,
        handler.timeoutMs ?? 5000,
      );
    };
  }
  if (handler.module) {
    return async (event: HookEvent) => {
      const { runModuleHandler } = await import("./runner.js");
      return runModuleHandler(
        handler.module as string,
        event.name,
        event.payload,
      );
    };
  }
  // No command or module — return continue. Misconfigured handlers
  // are no-ops, not errors, so the orchestrator can keep running.
  return async () => ({ kind: "continue" as const });
}

export class HookRegistry {
  private handlers = new Map<HookEventName, StoredHandler[]>();
  private middlewares: HookMiddleware[] = [];

  /**
   * Register a handler for an event. Accepts either a `HookFn`
   * (function) or a `HookHandler` object (declarative). Handlers
   * run in registration order. Multiple handlers per event are
   * allowed; they compose.
   */
  on(eventName: HookEventName, handler: HookFn | HookHandler): this {
    const stored: StoredHandler = isHookFn(handler)
      ? { input: handler, match: undefined, run: handler }
      : {
          input: handler,
          match: handler.match,
          run: declarativeToFn(handler),
        };
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(stored);
    this.handlers.set(eventName, existing);
    return this;
  }

  /**
   * Unregister a handler. Returns `true` if the handler was found
   * and removed, `false` otherwise. Idempotent. The argument is
   * compared by reference against the original input passed to `on()`.
   */
  unregister(
    eventName: HookEventName,
    handler: HookFn | HookHandler,
  ): boolean {
    const existing = this.handlers.get(eventName);
    if (!existing) return false;
    const idx = existing.findIndex((s) => s.input === handler);
    if (idx === -1) return false;
    existing.splice(idx, 1);
    if (existing.length === 0) this.handlers.delete(eventName);
    return true;
  }

  /**
   * Add a middleware. Middlewares run before handlers and can
   * short-circuit by returning `block`. They cannot `modify` (no
   * payload to modify yet).
   */
  use(middleware: HookMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * Fire an event. Returns the composed decision.
   *
   * Composition rules (in order):
   * - First `block` (from middleware or handler) short-circuits.
   * - All `add-context` are concatenated with `\n\n`.
   * - Last `modify` wins (PostToolUse only; for other events, `modify`
   *   is treated as `continue` since there's no payload to modify
   *   before the model sees it).
   * - Otherwise, `continue`.
   */
  async fire(
    eventName: HookEventName,
    payload: unknown,
  ): Promise<HookDecision> {
    // Middlewares first. They can short-circuit.
    for (const middleware of this.middlewares) {
      const decision = await middleware(eventName, payload);
      if (decision.kind === "block") return decision;
    }

    // Matched handlers, in registration order.
    const handlers = this.handlers.get(eventName) ?? [];
    const matched = handlers.filter((h) => this.matchHandler(h, payload));

    let lastModify: Extract<HookDecision, { kind: "modify" }> | null = null;
    let lastAsk: Extract<HookDecision, { kind: "ask" }> | null = null;
    const contexts: string[] = [];

    for (const handler of matched) {
      const decision = await handler.run({ name: eventName, payload });
      if (decision.kind === "block") return decision;
      if (decision.kind === "modify") {
        if (eventName === "PostToolUse") {
          // Only PostToolUse accepts modify.
          lastModify = decision;
        }
        // For other events, treat modify as continue (no payload to
        // modify before the model sees it).
      }
      if (decision.kind === "add-context") {
        contexts.push(decision.content);
      }
      if (decision.kind === "ask") {
        // F9.1: ask is PreToolUse only. Stash the last ask;
        // if no block came first, return the ask at the end
        // (after the loop) so multiple handlers compose: a
        // block wins; otherwise the last ask wins.
        if (eventName === "PreToolUse") {
          lastAsk = decision;
        }
      }
    }

    if (contexts.length > 0) {
      return { kind: "add-context", content: contexts.join("\n\n") };
    }
    if (lastModify) return lastModify;
    if (lastAsk) return lastAsk;
    return { kind: "continue" };
  }

  /** List registered events (for diagnostics). */
  listEvents(): HookEventName[] {
    return Array.from(this.handlers.keys());
  }

  /** Number of registered handlers (for diagnostics). */
  size(): number {
    let n = 0;
    for (const list of this.handlers.values()) n += list.length;
    return n;
  }

  /**
   * Remove all handlers and middlewares. Test-only utility;
   * production code should not call this in normal flow.
   */
  clear(): void {
    this.handlers.clear();
    this.middlewares = [];
  }

  /**
   * Test if a handler's `match` clause matches the payload.
   * A handler with no `match` matches everything.
   */
  private matchHandler(handler: StoredHandler, payload: unknown): boolean {
    if (!handler.match) return true;
    const p = payload as PayloadWithTool;
    if (handler.match.tool && p.tool !== handler.match.tool) return false;
    if (handler.match.pattern) {
      const re = new RegExp(handler.match.pattern);
      if (!re.test(JSON.stringify(payload))) return false;
    }
    return true;
  }
}

/**
 * The default registry. Handlers register into this at module load.
 * The orchestrator fires events through this at runtime.
 *
 * Tests should not use this; create a local `new HookRegistry()` per
 * test for isolation.
 */
export const defaultRegistry = new HookRegistry();
