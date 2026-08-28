/**
 * Phase B / Item 15.2 — `registerHooksFromConfig` tests.
 *
 * **Hermetic:** the helper just registers specs on a real
 * `HookRegistry`. The hook bodies are simple commands
 * (`echo`, `cat`) that don't need any external state.
 *
 * **Coverage:**
 * 1. A spec registers a handler that runs on the right event.
 * 2. Two specs for the same event → both run (composition).
 * 3. A spec with `match.pattern` only fires when the
 *    payload matches.
 * 4. The returned disposer unregisters all the handlers
 *    it registered.
 */

import { describe, expect, it } from "vitest";

import {
  HookRegistry,
  registerHooksFromConfig,
  type HookHandlerSpec,
} from "../../src/index.js";

describe("registerHooksFromConfig", () => {
  it("registers a single spec on the right event", async () => {
    const registry = new HookRegistry();
    const specs: HookHandlerSpec[] = [
      {
        event: "PreToolUse",
        command: "echo fired",
      },
    ];
    registerHooksFromConfig(registry, specs);
    const decision = await registry.fire("PreToolUse", { tool: "bash" });
    expect(decision.kind).toBe("add-context");
    if (decision.kind === "add-context") {
      expect(decision.content).toBe("fired");
    }
  });

  it("registers two specs for the same event (composition)", async () => {
    const registry = new HookRegistry();
    const specs: HookHandlerSpec[] = [
      { event: "Stop", command: "echo first" },
      { event: "Stop", command: "echo second" },
    ];
    registerHooksFromConfig(registry, specs);
    const decision = await registry.fire("Stop", {});
    // Both hooks run; the contexts are concatenated
    // (per the registry's composition rules).
    expect(decision.kind).toBe("add-context");
    if (decision.kind === "add-context") {
      expect(decision.content).toContain("first");
      expect(decision.content).toContain("second");
    }
  });

  it("match.pattern filters which payloads fire the handler", async () => {
    const registry = new HookRegistry();
    const specs: HookHandlerSpec[] = [
      {
        event: "PreToolUse",
        command: "echo matched",
        match: { pattern: "bash" },
      },
    ];
    registerHooksFromConfig(registry, specs);
    // Match: tool=bash.
    const match = await registry.fire("PreToolUse", { tool: "bash" });
    expect(match.kind).toBe("add-context");
    // No match: tool=read_file.
    const noMatch = await registry.fire("PreToolUse", { tool: "read_file" });
    expect(noMatch.kind).toBe("continue");
  });

  it("the disposer unregisters all the registered handlers", async () => {
    const registry = new HookRegistry();
    const specs: HookHandlerSpec[] = [
      { event: "PreToolUse", command: "echo first" },
      { event: "PreToolUse", command: "echo second" },
      { event: "Stop", command: "echo stop" },
    ];
    const dispose = registerHooksFromConfig(registry, specs);
    expect(registry.size()).toBe(3);
    dispose();
    expect(registry.size()).toBe(0);
  });
});
