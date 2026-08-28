/**
 * Phase B / Item 3.1 — built-in `audit-log` plugin tests.
 *
 * **Hermetic:** the plugin is pure logic. Tests use a
 * real `HookRegistry` and a fake logger; the hook is
 * fired synthetically. No I/O.
 *
 * **Coverage:**
 * 1. The plugin's `apply` registers a `PostToolUse`
 *    hook on the agent's `HookRegistry`.
 * 2. The hook fires on `PostToolUse` events; the log
 *    line includes the tool name + the result
 *    summary (ok / error).
 * 3. The returned `Disposable` unregisters the hook
 *    (no more log lines after dispose).
 * 4. The plugin respects the `config.prefix` field.
 * 5. The plugin uses the default prefix `"audit"`
 *    when no config is supplied.
 */

import { describe, expect, it } from "vitest";

import {
  auditLogPlugin,
  type CapabilityContext,
  type HookRegistry,
} from "../../../src/index.js";

function makeCtx(): CapabilityContext & {
  logCalls: string[];
} {
  const logCalls: string[] = [];
  return {
    cwd: "/test",
    hooks: {} as unknown as HookRegistry, // replaced per-test
    tools: {
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

describe("audit-log plugin", () => {
  it("registers a PostToolUse hook on apply", async () => {
    const { HookRegistry } = await import("../../../src/index.js");
    const hooks = new HookRegistry();
    const ctx = { ...makeCtx(), hooks };
    auditLogPlugin.apply(ctx, {});
    // After apply, a PostToolUse event should fire
    // the hook.
    await hooks.fire("PostToolUse", { tool: "bash" });
    expect(ctx.logCalls).toHaveLength(1);
    expect(ctx.logCalls[0]).toMatch(/^info: audit tool=bash result=ok$/);
  });

  it("logs error status when the tool's isError is true", async () => {
    const { HookRegistry } = await import("../../../src/index.js");
    const hooks = new HookRegistry();
    const ctx = { ...makeCtx(), hooks };
    auditLogPlugin.apply(ctx, {});
    await hooks.fire("PostToolUse", { tool: "bash", isError: true });
    expect(ctx.logCalls[0]).toMatch(/result=error$/);
  });

  it("uses a custom prefix from config", async () => {
    const { HookRegistry } = await import("../../../src/index.js");
    const hooks = new HookRegistry();
    const ctx = { ...makeCtx(), hooks };
    auditLogPlugin.apply(ctx, { prefix: "my-app" });
    await hooks.fire("PostToolUse", { tool: "read_file" });
    expect(ctx.logCalls[0]).toMatch(/^info: my-app tool=read_file/);
  });

  it("dispose() unregisters the hook", async () => {
    const { HookRegistry } = await import("../../../src/index.js");
    const hooks = new HookRegistry();
    const ctx = { ...makeCtx(), hooks };
    const result = auditLogPlugin.apply(ctx, {});
    // `apply` returns `void | Disposable`. The audit-log
    // plugin always returns a `Disposable`; we narrow
    // with a runtime check for safety.
    if (typeof result !== "function") {
      throw new Error("expected audit-log plugin to return a Disposable");
    }
    const dispose = result;
    await hooks.fire("PostToolUse", { tool: "bash" });
    expect(ctx.logCalls).toHaveLength(1);
    dispose();
    await hooks.fire("PostToolUse", { tool: "bash" });
    // No new log line after dispose.
    expect(ctx.logCalls).toHaveLength(1);
  });
});
