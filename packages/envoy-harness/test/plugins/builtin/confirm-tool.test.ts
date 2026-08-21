/**
 * Phase B / Item 3.2 — built-in `confirm-tool` plugin tests.
 *
 * **Hermetic:** the plugin is pure logic. Tests use a
 * real `HookRegistry`; the hook is fired synthetically
 * with a payload shaped like a real `PreToolUse` event.
 * No I/O, no LLM, no real kernel.
 *
 * **Coverage:**
 * 1. The plugin registers a `PreToolUse` handler on
 *    the agent's `HookRegistry`.
 * 2. The handler returns `ask` when the payload's
 *    `tool` field matches the default target (`bash`).
 * 3. The handler returns `continue` when the payload's
 *    `tool` field doesn't match (filtering is internal;
 *    the registry's `match` field isn't used for
 *    inline `HookFn` calls).
 * 4. A custom target via `config.tool` overrides the
 *    default (`bash`).
 * 5. The `ask` decision includes the standard
 *    "Allow / Deny" options (F9.1 wire shape).
 * 6. The returned `Disposable` unregisters the handler
 *    (no more `ask` decisions after dispose).
 */

import { describe, expect, it } from "vitest";

import {
  confirmToolPlugin,
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

describe("confirm-tool plugin", () => {
  it("registers a PreToolUse hook on apply", async () => {
    const { HookRegistry } = await import("../../../src/index.js");
    const hooks = new HookRegistry();
    const ctx = { ...makeCtx(), hooks };
    confirmToolPlugin.apply(ctx, {});
    // After apply, a PreToolUse event with a `bash`
    // payload should fire the hook and return `ask`.
    const decision = await hooks.fire("PreToolUse", { tool: "bash" });
    expect(decision.kind).toBe("ask");
  });

  it("returns ask for the default target (bash)", async () => {
    const { HookRegistry } = await import("../../../src/index.js");
    const hooks = new HookRegistry();
    const ctx = { ...makeCtx(), hooks };
    confirmToolPlugin.apply(ctx, {});
    const decision = await hooks.fire("PreToolUse", { tool: "bash" });
    if (decision.kind !== "ask") {
      throw new Error(`expected ask, got ${decision.kind}`);
    }
    expect(decision.question).toMatch(/bash/);
    expect(decision.options).toEqual([
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ]);
  });

  it("returns continue for a non-matching tool (filter)", async () => {
    const { HookRegistry } = await import("../../../src/index.js");
    const hooks = new HookRegistry();
    const ctx = { ...makeCtx(), hooks };
    confirmToolPlugin.apply(ctx, {});
    const decision = await hooks.fire("PreToolUse", { tool: "read_file" });
    expect(decision.kind).toBe("continue");
  });

  it("uses a custom target tool from config", async () => {
    const { HookRegistry } = await import("../../../src/index.js");
    const hooks = new HookRegistry();
    const ctx = { ...makeCtx(), hooks };
    confirmToolPlugin.apply(ctx, { tool: "read_file" });
    // The custom target now matches; `bash` does NOT.
    const askDecision = await hooks.fire("PreToolUse", { tool: "read_file" });
    expect(askDecision.kind).toBe("ask");
    const continueDecision = await hooks.fire("PreToolUse", { tool: "bash" });
    expect(continueDecision.kind).toBe("continue");
  });

  it("dispose() unregisters the handler", async () => {
    const { HookRegistry } = await import("../../../src/index.js");
    const hooks = new HookRegistry();
    const ctx = { ...makeCtx(), hooks };
    const result = confirmToolPlugin.apply(ctx, {});
    if (typeof result !== "function") {
      throw new Error("expected confirm-tool to return a Disposable");
    }
    const dispose = result;
    const before = await hooks.fire("PreToolUse", { tool: "bash" });
    expect(before.kind).toBe("ask");
    dispose();
    const after = await hooks.fire("PreToolUse", { tool: "bash" });
    // No handler registered → default is `continue`.
    expect(after.kind).toBe("continue");
  });
});
