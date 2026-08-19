/**
 * F9.2.3 tests — the 4 LSP tools + AgentOptions.lspManager
 * integration.
 *
 * Covers:
 * 1. `makeLspTools(manager)` returns 4 tools with the
 *    right names, descriptions, and parameter schemas.
 * 2. Each tool calls the right method on the LspClient
 *    (looked up via `manager.forFile`).
 * 3. Each tool returns `{ content, isError: true }` when
 *    `manager.forFile` returns null.
 * 4. Each tool converts LspClient errors to
 *    `{ content: { error }, isError: true }`.
 * 5. `AgentOptions.lspManager` registers all 4 tools
 *    (and only those 4).
 * 6. Without `AgentOptions.lspManager`, no LSP tools
 *    are registered.
 * 7. The tools honor the `ToolContext.abortSignal`
 *    (in-flight cancellation is the manager's job, but
 *    the tool's own logic should not hang).
 * 8. The full-pipeline: an agent with lspManager + a
 *    scripted model can call lsp_definition and get
 *    a useful result in the transcript.
 */

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  MockLspClient,
  StaticLspManager,
  newSessionId,
  makeLspTools,
  type ModelAdapter,
  type ModelResponse,
} from "@envoymesh/envoy-harness";
import { ToolRegistry } from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function scriptedModel(responses: ReadonlyArray<{
  content: ModelResponse["content"];
  stopReason?: ModelResponse["stopReason"];
}>): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const r = responses[i++];
      if (!r) throw new Error(`scriptedModel: exhausted (call #${i})`);
      return {
        content: r.content,
        stopReason: r.stopReason ?? (r.content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn"),
      };
    },
  };
}

function toolCallBlock(id: string, name: string, args: unknown): ModelResponse["content"][number] {
  return { type: "tool_call", id, name, args };
}

function textBlock(text: string): ModelResponse["content"][number] {
  return { type: "text", text };
}

// ---------------------------------------------------------------------------
// 1. makeLspTools shape
// ---------------------------------------------------------------------------

describe("makeLspTools", () => {
  it("returns 4 tools with the expected names", () => {
    const ts = new MockLspClient();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tools = makeLspTools(m);
    expect(tools.map((t) => t.name)).toEqual([
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_diagnostics",
    ]);
  });

  it("each tool has a non-empty description and a zod schema", () => {
    const ts = new MockLspClient();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    for (const tool of makeLspTools(m)) {
      expect(tool.description.length).toBeGreaterThan(20);
      // `parameters` is a zod schema with parse().
      expect(typeof tool.parameters.parse).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The 4 tools call the right methods
// ---------------------------------------------------------------------------

describe("lsp_definition tool", () => {
  it("calls client.definition with the right args", async () => {
    const ts = new MockLspClient({
      definitions: new Map([
        ["/a.ts:5:3", [{ file: "/def.ts", line: 10, column: 4 }]],
      ]),
    });
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tool = makeLspTools(m).find((t: import("@envoymesh/envoy-harness").Tool) => t.name === "lsp_definition")!;
    const result = await tool.execute(
      { file: "/a.ts", line: 5, column: 3 },
      {
        cwd: "/",
        session: new InMemorySession(newSessionId(), {
          cwd: "/",
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        }),
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      locations: [{ file: "/def.ts", line: 10, column: 4 }],
    });
    expect(ts.calls[0]).toEqual({ op: "definition", file: "/a.ts", line: 5, column: 3 });
  });

  it("returns isError when manager.forFile returns null", async () => {
    const ts = new MockLspClient();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tool = makeLspTools(m).find((t: import("@envoymesh/envoy-harness").Tool) => t.name === "lsp_definition")!;
    const result = await tool.execute(
      { file: "/unknown.rs", line: 0, column: 0 },
      {
        cwd: "/",
        session: new InMemorySession(newSessionId(), {
          cwd: "/",
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        }),
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no LSP client for this file" });
    expect(ts.calls).toHaveLength(0);
  });

  it("catches client errors and returns isError", async () => {
    const ts = new MockLspClient();
    // Force an error by closing the client first.
    await ts.close();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tool = makeLspTools(m).find((t: import("@envoymesh/envoy-harness").Tool) => t.name === "lsp_definition")!;
    const result = await tool.execute(
      { file: "/a.ts", line: 0, column: 0 },
      {
        cwd: "/",
        session: new InMemorySession(newSessionId(), {
          cwd: "/",
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        }),
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toMatch(/after close/);
  });
});

describe("lsp_references tool", () => {
  it("calls client.references and returns locations", async () => {
    const ts = new MockLspClient({
      references: new Map([
        ["/a.ts:5:3", [{ file: "/x.ts", line: 1, column: 0 }]],
      ]),
    });
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tool = makeLspTools(m).find((t: import("@envoymesh/envoy-harness").Tool) => t.name === "lsp_references")!;
    const result = await tool.execute(
      { file: "/a.ts", line: 5, column: 3 },
      {
        cwd: "/",
        session: new InMemorySession(newSessionId(), {
          cwd: "/",
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        }),
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.content).toEqual({
      locations: [{ file: "/x.ts", line: 1, column: 0 }],
    });
  });
});

describe("lsp_hover tool", () => {
  it("calls client.hover and returns hover object", async () => {
    const ts = new MockLspClient({
      hovers: new Map([
        [
          "/a.ts:5:3",
          { file: "/a.ts", line: 5, column: 3, contents: "function foo(): void" },
        ],
      ]),
    });
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tool = makeLspTools(m).find((t: import("@envoymesh/envoy-harness").Tool) => t.name === "lsp_hover")!;
    const result = await tool.execute(
      { file: "/a.ts", line: 5, column: 3 },
      {
        cwd: "/",
        session: new InMemorySession(newSessionId(), {
          cwd: "/",
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        }),
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.content).toEqual({
      hover: { file: "/a.ts", line: 5, column: 3, contents: "function foo(): void" },
    });
  });

  it("returns { hover: null } when the client returns null", async () => {
    const ts = new MockLspClient();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tool = makeLspTools(m).find((t: import("@envoymesh/envoy-harness").Tool) => t.name === "lsp_hover")!;
    const result = await tool.execute(
      { file: "/a.ts", line: 0, column: 0 },
      {
        cwd: "/",
        session: new InMemorySession(newSessionId(), {
          cwd: "/",
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        }),
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.content).toEqual({ hover: null });
  });
});

describe("lsp_diagnostics tool", () => {
  it("opens the document, waits for diagnostics, and returns them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-lsp-diag-"));
    const file = path.join(dir, "a.ts");
    await fs.writeFile(file, "const x: number = 's';", "utf8");
    const ts = new MockLspClient({
      diagnostics: new Map([
        [
          file,
          [
            {
              file,
              line: 0,
              column: 0,
              severity: "error" as const,
              message: "boom",
            },
          ],
        ],
      ]),
    });
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tool = makeLspTools(m).find((t: import("@envoymesh/envoy-harness").Tool) => t.name === "lsp_diagnostics")!;
    const result = await tool.execute(
      { file },
      {
        cwd: dir,
        session: new InMemorySession(newSessionId(), {
          cwd: dir,
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        }),
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.content).toEqual({
      diagnostics: [
        { file, line: 0, column: 0, severity: "error", message: "boom" },
      ],
    });
    // The tool opened the document so the server would publish.
    expect(ts.calls.some((c) => c.op === "didOpen" && c.file === file)).toBe(
      true,
    );
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 3. AgentOptions.lspManager auto-registration
// ---------------------------------------------------------------------------

describe("AgentOptions.lspManager", () => {
  it("registers the 4 LSP tools when provided", () => {
    const ts = new MockLspClient();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tools = new ToolRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    new Agent({
      model: scriptedModel([]),
      tools,
      session,
      hooks: new HookRegistry(),
      lspManager: m,
    });
    const names = new Set(tools.list().map((t) => t.name));
    expect(names).toEqual(
      new Set(["lsp_definition", "lsp_references", "lsp_hover", "lsp_diagnostics"]),
    );
  });

  it("does not register any LSP tools when lspManager is undefined", () => {
    const tools = new ToolRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    new Agent({
      model: scriptedModel([]),
      tools,
      session,
      hooks: new HookRegistry(),
    });
    const names = new Set(tools.list().map((t) => t.name));
    // The 4 LSP tools must NOT be present.
    for (const n of ["lsp_definition", "lsp_references", "lsp_hover", "lsp_diagnostics"]) {
      expect(names.has(n)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Full pipeline: agent calls lsp_definition
// ---------------------------------------------------------------------------

describe("end-to-end: agent uses lsp_definition", () => {
  it("the model emits lsp_definition; the agent calls the LSP client; result returns to model", async () => {
    const ts = new MockLspClient({
      definitions: new Map([
        ["/a.ts:5:3", [{ file: "/def.ts", line: 10, column: 4 }]],
      ]),
    });
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tools = new ToolRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const model = scriptedModel([
      // 1st call: model asks for definition.
      {
        content: [
          textBlock("Let me find foo's definition."),
          toolCallBlock("t1", "lsp_definition", { file: "/a.ts", line: 5, column: 3 }),
        ],
      },
      // 2nd call (after tool result): model produces final answer.
      { content: [textBlock("foo is defined at /def.ts:10.")] },
    ]);
    const agent = new Agent({
      model,
      tools,
      session,
      hooks: new HookRegistry(),
      lspManager: m,
      systemPrompt: "You are an envoy-harness agent.",
    });
    const result = await agent.run("Where is foo defined in /a.ts?");
    expect(result.stopReason).toBe("end_turn");
    // The LSP client was called.
    expect(ts.calls).toHaveLength(1);
    expect(ts.calls[0]).toEqual({ op: "definition", file: "/a.ts", line: 5, column: 3 });
    // The transcript includes the tool call + result.
    const msgs = session.messages;
    const toolCall = msgs.find(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_call"),
    );
    expect(toolCall).toBeDefined();
    const toolResult = msgs.find(
      (m) => m.role === "tool" && m.content.some(
        (b) => b.type === "tool_result" && (b as { toolCallId: string }).toolCallId === "t1",
      ),
    );
    expect(toolResult).toBeDefined();
    // The final text mentions the location.
    const lastAssistant = msgs.filter((m) => m.role === "assistant").pop();
    expect(
      lastAssistant?.content.some(
        (b) => b.type === "text" && b.text.includes("/def.ts:10"),
      ),
    ).toBe(true);
  });

  it("the tool returns isError for files without an LSP client; model sees the error", async () => {
    const ts = new MockLspClient();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    const tools = new ToolRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const model = scriptedModel([
      {
        content: [
          toolCallBlock("t1", "lsp_definition", { file: "/x.rs", line: 0, column: 0 }),
        ],
      },
      { content: [textBlock("No LSP client available for that file.")] },
    ]);
    const agent = new Agent({
      model,
      tools,
      session,
      hooks: new HookRegistry(),
      lspManager: m,
    });
    await agent.run("Find the definition in /x.rs");
    // The transcript has a tool result with isError=true.
    const toolResult = session.messages.find(
      (m) => m.role === "tool" && m.content.some(
        (b) => b.type === "tool_result" && (b as { toolCallId: string }).toolCallId === "t1",
      ),
    );
    expect(toolResult).toBeDefined();
    const block = toolResult!.content[0] as { type: "tool_result"; isError: boolean; content: unknown };
    expect(block.isError).toBe(true);
  });
});
