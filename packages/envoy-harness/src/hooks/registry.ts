/**
 * HookRegistry — the in-memory store of hook handlers.
 *
 * **Design doc:** `docs/design.md` §8.2.
 * **R4.5a:** deny > ask > allow merge; fire() snapshots handlers so
 * refresh mid-turn does not drop an in-flight composition.
 *
 * **Three layers of composition (in order):**
 *
 * 1. **Middlewares** (added via `use()`). Run first; can short-circuit
 *    by returning `block`. Useful for cross-cutting concerns:
 *    audit logging, rate limiting, debug traces.
 *
 * 2. **Handlers** (added via `on()`). Matched against the event payload
 *    by `matchHandler`. Matched handlers **all run** (registration
 *    order); decisions merge via {@link mergeHookDecisions}
 *    (`block`/`deny` > `ask` > `continue`/`allow`).
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
 * `refresh`, `clear`. New decision kinds require a schema version bump;
 * new matchers are additive.
 */

import type {
  HookDecision,
  HookEvent,
  HookEventName,
  HookFn,
  HookHandler,
} from "../types.js";
import { mergeHookDecisions } from "./merge.js";

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
    return true;
  }

  /**
   * F17.2.5: list the (event, handlerCount) pairs for every
   * event with at least one registered handler. Used by
   * `/hooks`. Returns events in registration order (the
   * order in which the first handler was registered).
   */
  list(): ReadonlyArray<{ event: string; handlerCount: number }> {
    const out: Array<{ event: string; handlerCount: number }> = [];
    for (const [event, handlers] of this.handlers.entries()) {
      if (handlers.length === 0) continue;
      out.push({ event, handlerCount: handlers.length });
    }
    return out;
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
   * R4.5a — clear handlers/middlewares and run `reconfigure` to
   * re-register. In-flight {@link fire} calls keep their snapshotted
   * handler lists, so a mid-turn refresh does not drop the current
   * composition.
   */
  refresh(reconfigure: (registry: HookRegistry) => void): void {
    this.clear();
    reconfigure(this);
  }

  /**
   * Fire an event. Returns the composed decision.
   *
   * Composition rules (R4.5a):
   * - Middleware `block` still short-circuits (before handlers).
   * - All matched handlers run; merge is deny > ask > allow
   *   ({@link mergeHookDecisions}).
   * - Handler list is snapshotted at start (refresh-safe).
   */
  async fire(
    eventName: HookEventName,
    payload: unknown,
  ): Promise<HookDecision> {
    // Snapshot so refresh()/clear() mid-fire cannot drop this turn.
    const middlewares = this.middlewares.slice();
    const handlers = (this.handlers.get(eventName) ?? []).slice();

    for (const middleware of middlewares) {
      let decision: HookDecision;
      try {
        decision = await middleware(eventName, payload);
      } catch (err) {
        return {
          kind: "block",
          reason: `hook middleware threw: ${(err as Error).message}`,
        };
      }
      if (decision.kind === "block") return decision;
    }

    const matched = handlers.filter((h) => this.matchHandler(h, payload));
    const decisions: HookDecision[] = [];

    for (const handler of matched) {
      try {
        decisions.push(await handler.run({ name: eventName, payload }));
      } catch (err) {
        decisions.push({
          kind: "block",
          reason: `hook threw: ${(err as Error).message}`,
        });
      }
    }

    return mergeHookDecisions(eventName, decisions);
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
   * production code should prefer {@link refresh}.
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
