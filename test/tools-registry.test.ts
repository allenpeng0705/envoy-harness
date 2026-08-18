/**
 * ToolRegistry tests (§10 of the design).
 *
 * Covers registration, lookup, duplicate detection, and the
 * diagnostic surface (names, list, size). The tool execution
 * path is exercised end-to-end in `agent.test.ts` (Chunk 4b).
 *
 * **Test isolation:** every test gets a fresh `new ToolRegistry()`.
 * Module-level state is a known source of "passes in isolation,
 * fails in suite" bugs.
 */

import { z } from "zod";

import { describe, expect, it } from "vitest";

import { DuplicateToolError, ToolRegistry, type Tool } from "../src/index.js";

const echoTool: Tool<z.ZodObject<{ message: z.ZodString }>> = {
  name: "echo",
  description: "Echo the message back.",
  parameters: z.object({ message: z.string() }),
  async execute({ message }) {
    return { content: message };
  },
};

const sumTool: Tool<z.ZodObject<{ a: z.ZodNumber; b: z.ZodNumber }>> = {
  name: "sum",
  description: "Add two numbers.",
  parameters: z.object({ a: z.number(), b: z.number() }),
  async execute({ a, b }) {
    return { content: a + b };
  },
};

describe("ToolRegistry: registration", () => {
  it("registers a tool and returns it via get()", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(r.get("echo")).toBe(echoTool);
  });

  it("returns undefined for unknown tools", () => {
    const r = new ToolRegistry();
    expect(r.get("nope")).toBeUndefined();
  });

  it("has() returns true for registered, false for unknown", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(r.has("echo")).toBe(true);
    expect(r.has("nope")).toBe(false);
  });

  it("throws DuplicateToolError when registering twice", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(() => r.register(echoTool)).toThrow(DuplicateToolError);
  });

  it("the registered tool's name is the source of truth", () => {
    // We can't register a tool under a different key — `name` on
    // the tool itself is the only key. This test verifies the
    // `register(tool)` signature doesn't accept a separate key.
    const r = new ToolRegistry();
    r.register(echoTool);
    // There's no "alias" path; the name is fixed.
    expect(r.names()).toEqual(["echo"]);
  });
});

describe("ToolRegistry: listing", () => {
  it("names() returns all registered tool names", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    r.register(sumTool);
    expect(r.names().sort()).toEqual(["echo", "sum"]);
  });

  it("list() returns all registered tools", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    r.register(sumTool);
    const tools = r.list();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["echo", "sum"]);
  });

  it("size() returns the number of registered tools", () => {
    const r = new ToolRegistry();
    expect(r.size()).toBe(0);
    r.register(echoTool);
    expect(r.size()).toBe(1);
    r.register(sumTool);
    expect(r.size()).toBe(2);
  });
});

describe("ToolRegistry: unregister and clear", () => {
  it("unregister() returns true on hit, false on miss", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(r.unregister("echo")).toBe(true);
    expect(r.unregister("echo")).toBe(false);
    expect(r.unregister("nope")).toBe(false);
  });

  it("clear() removes all tools", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    r.register(sumTool);
    r.clear();
    expect(r.size()).toBe(0);
    expect(r.names()).toEqual([]);
  });
});

describe("ToolRegistry: tool execution (smoke)", () => {
  it("registered tool's execute() runs and returns a result", async () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    const tool = r.get("echo");
    expect(tool).toBeDefined();
    const args = tool!.parameters.parse({ message: "hello" });
    const result = await tool!.execute(args, {
      cwd: "/tmp",
      session: undefined as never, // echo doesn't use session
      abortSignal: AbortSignal.timeout(1000),
    });
    expect(result).toEqual({ content: "hello" });
  });

  it("sum tool computes correctly", async () => {
    const r = new ToolRegistry();
    r.register(sumTool);
    const tool = r.get("sum")!;
    const args = tool.parameters.parse({ a: 2, b: 3 });
    const result = await tool.execute(args, {
      cwd: "/tmp",
      session: undefined as never,
      abortSignal: AbortSignal.timeout(1000),
    });
    expect(result).toEqual({ content: 5 });
  });
});
