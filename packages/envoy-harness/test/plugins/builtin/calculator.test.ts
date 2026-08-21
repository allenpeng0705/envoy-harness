/**
 * Phase B / Item 3.2 — built-in `calculator` plugin tests.
 *
 * **Hermetic:** the expression evaluator is pure; the
 * `calculator` tool's `execute` is a pure function of
 * (args, context). Tests use a real `ToolRegistry` +
 * a fake `ToolContext`. No I/O, no LLM.
 *
 * **Coverage:**
 * 1. The `calculator` tool is registered on `ctx.tools`
 *    after `apply` (the registry's `get` returns it).
 * 2. `calculator.invoke({ expression: "2 + 2" })` →
 *    result `{ result: "4.000000" }` (the default
 *    precision is 6).
 * 3. `calculator.invoke({ expression: "1 / 3" })` →
 *    result `{ result: "0.166667" }` (1/3 rounded to
 *    6 decimal places).
 * 4. Custom precision via `config.precision`:
 *    `{ precision: 2 }` → `1/3` rounds to
 *    `{ result: "0.17" }`.
 * 5. The expression evaluator handles parens,
 *    unary minus, and chained operations
 *    (3 + 4 * 2 = 11; (3 + 4) * 2 = 14;
 *    -5 + 10 = 5).
 * 6. The expression evaluator throws on invalid input
 *    (division by zero, unmatched paren, bad char).
 * 7. The returned `Disposable` unregisters the tool
 *    (no `calculator` in the registry after dispose).
 */

import { describe, expect, it } from "vitest";

import {
  CalculatorError,
  calculatorPlugin,
  evaluateExpression,
  type CapabilityContext,
  type ToolRegistry,
} from "../../../src/index.js";

function makeCtx(): CapabilityContext & {
  logCalls: string[];
} {
  const logCalls: string[] = [];
  return {
    cwd: "/test",
    hooks: {
      on: () => undefined,
      unregister: () => false,
      use: () => undefined,
      fire: async () => ({ kind: "continue" as const }),
      clear: () => undefined,
      list: () => [],
      listEvents: () => [],
      size: () => 0,
    } as unknown as CapabilityContext["hooks"],
    tools: {} as unknown as ToolRegistry, // replaced per-test
    logger: {
      info: (msg: string) => logCalls.push(`info: ${msg}`),
      warn: (msg: string) => logCalls.push(`warn: ${msg}`),
      error: (msg: string) => logCalls.push(`error: ${msg}`),
    },
    logCalls,
  };
}

describe("evaluateExpression (pure)", () => {
  it("evaluates basic arithmetic", () => {
    expect(evaluateExpression("2 + 2")).toBe(4);
    expect(evaluateExpression("10 - 3")).toBe(7);
    expect(evaluateExpression("4 * 5")).toBe(20);
    expect(evaluateExpression("10 / 4")).toBe(2.5);
  });

  it("respects operator precedence", () => {
    // `*` binds tighter than `+`: 3 + 4 * 2 = 11.
    expect(evaluateExpression("3 + 4 * 2")).toBe(11);
    expect(evaluateExpression("(3 + 4) * 2")).toBe(14);
  });

  it("supports unary minus", () => {
    expect(evaluateExpression("-5 + 10")).toBe(5);
    expect(evaluateExpression("-(2 + 3)")).toBe(-5);
  });

  it("supports decimals and chained operations", () => {
    expect(evaluateExpression("0.1 + 0.2")).toBeCloseTo(0.3, 10);
    expect(evaluateExpression("1.5 * 2 + 1")).toBe(4);
  });

  it("throws CalculatorError on invalid input", () => {
    expect(() => evaluateExpression("")).toThrow(CalculatorError);
    expect(() => evaluateExpression("2 +")).toThrow(CalculatorError);
    expect(() => evaluateExpression("(2 + 3")).toThrow(CalculatorError);
    expect(() => evaluateExpression("1 / 0")).toThrow(/division by zero/);
    expect(() => evaluateExpression("2 + @")).toThrow(CalculatorError);
  });
});

describe("calculator plugin", () => {
  it("registers the calculator tool on ctx.tools after apply", async () => {
    const { ToolRegistry } = await import("../../../src/index.js");
    const tools = new ToolRegistry();
    const ctx = { ...makeCtx(), tools };
    calculatorPlugin.apply(ctx, {});
    const tool = tools.get("calculator");
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("calculator");
  });

  it("evaluates expressions via the registered tool (default precision)", async () => {
    const { ToolRegistry } = await import("../../../src/index.js");
    const tools = new ToolRegistry();
    const ctx = { ...makeCtx(), tools };
    calculatorPlugin.apply(ctx, {});
    const tool = tools.get("calculator")!;
    const result = await tool.execute(
      { expression: "2 + 2" },
      {
        cwd: "/test",
        session: {} as never,
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.content).toEqual({ result: "4.000000" });
  });

  it("rounds 1/3 to 6 decimal places by default", async () => {
    const { ToolRegistry } = await import("../../../src/index.js");
    const tools = new ToolRegistry();
    const ctx = { ...makeCtx(), tools };
    calculatorPlugin.apply(ctx, {});
    const tool = tools.get("calculator")!;
    const result = await tool.execute(
      { expression: "1 / 3" },
      {
        cwd: "/test",
        session: {} as never,
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.content).toEqual({ result: "0.333333" });
  });

  it("respects a custom precision from config", async () => {
    const { ToolRegistry } = await import("../../../src/index.js");
    const tools = new ToolRegistry();
    const ctx = { ...makeCtx(), tools };
    calculatorPlugin.apply(ctx, { precision: 2 });
    const tool = tools.get("calculator")!;
    const result = await tool.execute(
      { expression: "1 / 3" },
      {
        cwd: "/test",
        session: {} as never,
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.content).toEqual({ result: "0.33" });
  });

  it("dispose() unregisters the calculator tool", async () => {
    const { ToolRegistry } = await import("../../../src/index.js");
    const tools = new ToolRegistry();
    const ctx = { ...makeCtx(), tools };
    const result = calculatorPlugin.apply(ctx, {});
    if (typeof result !== "function") {
      throw new Error("expected calculator plugin to return a Disposable");
    }
    const dispose = result;
    expect(tools.has("calculator")).toBe(true);
    dispose();
    expect(tools.has("calculator")).toBe(false);
  });
});
