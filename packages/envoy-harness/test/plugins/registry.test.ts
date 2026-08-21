/**
 * Phase B / Item 3.1 — `PluginRegistry` tests.
 *
 * **Hermetic:** the registry is pure logic; tests use
 * in-memory mock plugins + the real `HookRegistry` +
 * `ToolRegistry`. No I/O, no LLM.
 *
 * **Coverage:**
 * 1. `register` calls `apply(ctx, config)` with the
 *    supplied context + config.
 * 2. `register` returns the `Disposable` from `apply`
 *    (or a no-op when `apply` returns `void`).
 * 3. `dispose(name)` calls the registered `Disposable`.
 * 4. `dispose(name)` returns `false` when the name is
 *    not registered.
 * 5. A duplicate `name` in the registry throws.
 * 6. `disposeAll()` runs every `Disposable` in
 *    reverse-registration order.
 * 7. `list()` returns the registered names in
 *    registration order.
 * 8. `size()` returns the count of registered plugins.
 */

import { describe, expect, it } from "vitest";

import { HookRegistry } from "../../src/index.js";
import {
  PluginRegistry,
  type CapabilityContext,
  type CapabilityModule,
  type Disposable,
} from "../../src/index.js";

/** A minimal `CapabilityContext` for tests. The hooks +
 *  tools registries are real (we exercise them); the
 *  logger is a no-op. */
function makeCtx(): CapabilityContext & {
  logCalls: string[];
} {
  const logCalls: string[] = [];
  return {
    cwd: "/test",
    hooks: new HookRegistry(),
    tools: {
      // The registry only calls `register` on the
      // tools registry (and only plugins use it). v0
      // doesn't actually need tools for the registry
      // tests; we provide a stub.
      register: () => undefined,
      get: () => undefined,
      list: () => [],
      size: () => 0,
    } as unknown as CapabilityContext["tools"],
    logger: {
      info: (msg: string) => logCalls.push(`info: ${msg}`),
      warn: (msg: string) => logCalls.push(`warn: ${msg}`),
      error: (msg: string) => logCalls.push(`error: ${msg}`),
    },
    logCalls,
  };
}

/** A minimal `CapabilityModule` factory.
 *
 * `applyReturns` is the Disposable the plugin returns
 * from `apply` (returned AS-IS, not called — the
 * contract is "the function IS the disposable", not
 * "the function returns the disposable"). */
function makePlugin(name: string, opts: {
  applyReturns?: Disposable;
  applyThrows?: Error;
  sideEffect?: (ctx: CapabilityContext) => void;
} = {}): CapabilityModule {
  return {
    name,
    apply(ctx, _config) {
      opts.sideEffect?.(ctx);
      if (opts.applyThrows) throw opts.applyThrows;
      return opts.applyReturns;
    },
  };
}

describe("PluginRegistry: register", () => {
  it("calls apply(ctx, config) and tracks the returned Disposable", () => {
    const registry = new PluginRegistry();
    const ctx = makeCtx();
    const dispose: Disposable = () => undefined;
    const plugin = makePlugin("p1", { applyReturns: dispose });
    const returned = registry.register(plugin, { foo: 1 }, ctx);
    expect(returned).toBe(dispose);
    expect(registry.size()).toBe(1);
  });

  it("uses a no-op Disposable when apply returns void", () => {
    const registry = new PluginRegistry();
    const ctx = makeCtx();
    // `exactOptionalPropertyTypes: true` rejects
    // `applyReturns: undefined`; we omit the key
    // instead (makePlugin's `opts` is optional
    // throughout).
    const plugin = makePlugin("p1");
    const returned = registry.register(plugin, {}, ctx);
    expect(typeof returned).toBe("function");
    // Calling the no-op disposer doesn't throw.
    expect(() => returned()).not.toThrow();
  });

  it("throws on a duplicate name", () => {
    const registry = new PluginRegistry();
    const ctx = makeCtx();
    registry.register(makePlugin("p1"), {}, ctx);
    expect(() => registry.register(makePlugin("p1"), {}, ctx)).toThrow(
      /already registered/,
    );
  });

  it("passes the config to apply", () => {
    const registry = new PluginRegistry();
    const ctx = makeCtx();
    const seenConfigs: unknown[] = [];
    const plugin: CapabilityModule = {
      name: "p1",
      apply(_ctx, config) {
        seenConfigs.push(config);
        return undefined;
      },
    };
    registry.register(plugin, { answer: 42 }, ctx);
    expect(seenConfigs).toEqual([{ answer: 42 }]);
  });

  it("exposes the context to apply (hooks + tools are reachable)", () => {
    const registry = new PluginRegistry();
    const ctx = makeCtx();
    let observedCwd: string | undefined;
    let observedTools: unknown = undefined;
    const plugin: CapabilityModule = {
      name: "p1",
      apply(c, _cfg) {
        observedCwd = c.cwd;
        observedTools = c.tools;
        return undefined;
      },
    };
    registry.register(plugin, {}, ctx);
    expect(observedCwd).toBe("/test");
    expect(observedTools).toBe(ctx.tools);
  });
});

describe("PluginRegistry: dispose", () => {
  it("calls the registered Disposable and removes the plugin", () => {
    const registry = new PluginRegistry();
    const ctx = makeCtx();
    let disposed = false;
    // `applyReturns` is the Disposable the plugin
    // returns from `apply` (NOT a side effect to run
    // during `apply`). Our `makePlugin` returns it
    // as-is from `apply`, so the registry stores it
    // and can dispose it later.
    const plugin = makePlugin("p1", {
      applyReturns: () => {
        disposed = true;
      },
    });
    registry.register(plugin, {}, ctx);
    expect(registry.dispose("p1")).toBe(true);
    expect(disposed).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("returns false for an unknown name", () => {
    const registry = new PluginRegistry();
    expect(registry.dispose("never-registered")).toBe(false);
  });

  it("disposeAll() runs every Disposable in reverse-registration order", () => {
    const registry = new PluginRegistry();
    const ctx = makeCtx();
    const order: string[] = [];
    // Each plugin's `apply` returns a Disposable
    // that pushes its name to `order` when called.
    // `makePlugin` returns `applyReturns` as-is (so
    // the function is the Disposable, not its return
    // value).
    registry.register(
      makePlugin("a", {
        applyReturns: () => {
          order.push("a");
          return undefined;
        },
      }),
      {},
      ctx,
    );
    registry.register(
      makePlugin("b", {
        applyReturns: () => {
          order.push("b");
          return undefined;
        },
      }),
      {},
      ctx,
    );
    registry.register(
      makePlugin("c", {
        applyReturns: () => {
          order.push("c");
          return undefined;
        },
      }),
      {},
      ctx,
    );
    registry.disposeAll();
    // Reverse order: c, b, a.
    expect(order).toEqual(["c", "b", "a"]);
  });
});

describe("PluginRegistry: list + size", () => {
  it("list() returns the registered names in registration order", () => {
    const registry = new PluginRegistry();
    const ctx = makeCtx();
    registry.register(makePlugin("x"), {}, ctx);
    registry.register(makePlugin("y"), {}, ctx);
    registry.register(makePlugin("z"), {}, ctx);
    expect(registry.list()).toEqual(["x", "y", "z"]);
  });

  it("size() returns the count of registered plugins", () => {
    const registry = new PluginRegistry();
    const ctx = makeCtx();
    expect(registry.size()).toBe(0);
    registry.register(makePlugin("a"), {}, ctx);
    expect(registry.size()).toBe(1);
    registry.register(makePlugin("b"), {}, ctx);
    expect(registry.size()).toBe(2);
    registry.dispose("a");
    expect(registry.size()).toBe(1);
  });
});
