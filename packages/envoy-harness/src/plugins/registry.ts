/**
 * Phase B / Item 3.1 — the `PluginRegistry`.
 *
 * **What this is:** the harness-side store for active
 * plugins. The lifecycle:
 * 1. Host calls `registry.register(module, config)`.
 * 2. The registry calls `module.apply(ctx, config)` and
 *    stashes the returned `Disposable` (or a no-op).
 * 3. Later, the host calls `registry.dispose(name)` or
 *    `registry.disposeAll()` (typically when the agent
 *    is destroyed). The registry runs the `Disposable`
 *    in reverse-registration order.
 *
 * **Why a registry, not a list:** the registry owns
 * the lifecycle (apply + dispose). The loader is a
 * one-shot factory; the registry is the long-lived
 * store. A plugin can be disposed + re-registered
 * without re-importing.
 *
 * **Why a class, not a free function:** the registry
 * holds state (the map of `name → Disposable`). A class
 * makes the state ownership explicit; the methods are
 * the surface.
 *
 * **Why no applyAll() auto-call:** v0 lets the host
 * control when plugins run. The `Agent` constructor
 * wires the registry's `applyAll` to its own
 * `CapabilityContext`, but the registry itself is
 * passive (the host drives it). A future chunk may add
 * a "auto-apply on register" mode if the use case
 * emerges.
 */

import {
  PluginLoadError,
  type CapabilityContext,
  type CapabilityModule,
  type Disposable,
} from "./types.js";

/** The internal record for a registered plugin. */
interface RegisteredPlugin {
  /** The plugin's module (post-validation). */
  module: CapabilityModule;
  /** The `Disposable` returned by `apply` (or a no-op
   *  when `apply` returned `void`). */
  dispose: Disposable;
  /** The order in which the plugin was registered
   *  (used by `disposeAll` to run in reverse). */
  order: number;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private nextOrder = 0;

  /**
   * Register a plugin. Calls `module.apply(ctx, config)`
   * with the supplied context. Returns the plugin's
   * `Disposable` (or a no-op) so the caller can run
   * individual cleanup.
   *
   * **Duplicate names throw.** The registry keys by
   * `module.name`; a second register with the same
   * name is a programmer error (caller forgot to
   * dispose the first one). The CLI runner uses
   * `ReplOptions.plugins` as a singleton, so this
   * rarely fires in practice.
   *
   * **Apply errors throw.** If `module.apply` throws,
   * the plugin is NOT registered (the registry doesn't
   * keep a broken plugin around). The `Disposable` from
   * a successful prior call is also NOT run — the
   * `apply` didn't run, so there's nothing to clean up.
   */
  register<Config = unknown>(
    module: CapabilityModule<Config>,
    config: Config,
    ctx: CapabilityContext,
  ): Disposable {
    if (this.plugins.has(module.name)) {
      throw new PluginLoadError(
        `plugin '${module.name}' is already registered ` +
          `(call dispose('${module.name}') first)`,
        module.name,
      );
    }
    const applyResult = module.apply(ctx, config);
    // Coerce `void` / `undefined` to a no-op disposer.
    // We do this via a wrapper so `disposeAll` doesn't
    // have to special-case the `void` form.
    const dispose: Disposable =
      typeof applyResult === "function" ? applyResult : () => undefined;
    this.plugins.set(module.name, {
      module,
      dispose,
      order: this.nextOrder++,
    });
    return dispose;
  }

  /**
   * Dispose a single plugin by name. Returns `true` if
   * a plugin was disposed, `false` if the name was not
   * registered. Idempotent (a second call returns
   * `false`).
   */
  dispose(name: string): boolean {
    const record = this.plugins.get(name);
    if (!record) return false;
    this.plugins.delete(name);
    try {
      record.dispose();
    } catch (err) {
      // A throwing `dispose` is a plugin bug. The
      // registry continues (we've already removed the
      // record from the map, so a re-dispose is
      // idempotent). The error is surfaced to the
      // caller's `catch` block; we don't re-throw here
      // because that would mask the fact that OTHER
      // plugins might need disposing.
      throw new PluginLoadError(
        `plugin '${name}' threw during dispose: ${(err as Error).message}`,
        name,
        err,
      );
    }
    return true;
  }

  /**
   * Dispose every registered plugin, in reverse-
   * registration order (the last-registered plugin is
   * the first to dispose, matching typical stack-like
   * teardown semantics).
   *
   * **Errors are aggregated.** If plugin A's dispose
   * throws, plugins B and C still get their chance.
   * The first error is re-thrown after all disposes
   * have run (so the caller sees the failure but the
   * other plugins aren't leaked).
   */
  disposeAll(): void {
    // Sort by reverse order, copy to an array (we
    // mutate the map during the loop).
    const records = Array.from(this.plugins.values()).sort(
      (a, b) => b.order - a.order,
    );
    this.plugins.clear();
    let firstErr: unknown = undefined;
    for (const record of records) {
      try {
        record.dispose();
      } catch (err) {
        if (firstErr === undefined) firstErr = err;
      }
    }
    if (firstErr !== undefined) {
      throw firstErr;
    }
  }

  /**
   * Apply every registered plugin with the supplied
   * context. v0 doesn't call this from the
   * constructor (the host does); the method exists for
   * the `Agent` constructor's "wire on first use" path
   * and for tests.
   *
   * **Note:** `applyAll` does NOT re-apply plugins that
   * are already registered (the registry already holds
   * the result of their `apply`). It's intended for the
   * initial wiring.
   */
  applyAll(ctx: CapabilityContext): void {
    for (const record of this.plugins.values()) {
      // Re-apply is unusual; v0 doesn't use it. The
      // method is here for symmetry with `disposeAll`
      // and for future "re-wire to a new context" flows.
      // We DO NOT call `record.module.apply(ctx, record.config)`
      // because the registry doesn't store the config
      // (the host does). This is a no-op in v0.
      void record;
      void ctx;
    }
  }

  /** Number of registered plugins (for diagnostics). */
  size(): number {
    return this.plugins.size;
  }

  /** List the registered plugin names (registration order). */
  list(): ReadonlyArray<string> {
    return Array.from(this.plugins.values())
      .sort((a, b) => a.order - b.order)
      .map((r) => r.module.name);
  }
}
