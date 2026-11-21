/**
 * Wave 1 — code_mode + tool_search / deferred exposure.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  ToolRegistry,
  makeCodeModeTools,
  makeToolSearchTool,
  newSessionId,
  withExposure,
  type ModelAdapter,
  type ToolContext,
} from "../src/index.js";

function makeCtx(): ToolContext {
  return {
    cwd: "/tmp",
    session: new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    }),
    abortSignal: new AbortController().signal,
  };
}

describe("code_mode + tool_search", () => {
  it("code_mode_exec invokes granted tools", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        return { content: String((args as { text: string }).text) };
      },
    });
    const exec = makeCodeModeTools({ tools })[0]!;
    const res = await exec.execute(
      {
        code: `return await tools.invoke("echo", { text: "hi" });`,
        grantNamespaces: ["echo"],
      },
      makeCtx(),
    );
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(String(res.content)) as {
      ok: boolean;
      returnValue: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.returnValue).toBe("hi");
  });

  it("code_mode refuses deferred tools until granted", async () => {
    const tools = new ToolRegistry();
    tools.register(
      withExposure(
        {
          name: "secret_tool",
          description: "secret",
          parameters: z.object({}),
          async execute() {
            return { content: "nope" };
          },
        },
        "deferred",
      ),
    );
    const exec = makeCodeModeTools({ tools })[0]!;
    const res = await exec.execute(
      { code: `return await tools.invoke("secret_tool", {});` },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/not granted/);
  });

  it("tool_search grants deferred tools", async () => {
    const tools = new ToolRegistry();
    tools.register(
      withExposure(
        {
          name: "web_fetch_x",
          description: "fetch a URL from the web",
          parameters: z.object({ url: z.string() }),
          async execute() {
            return { content: "ok" };
          },
        },
        "deferred",
      ),
    );
    const search = makeToolSearchTool({ tools });
    tools.register(search);
    const res = await search.execute({ query: "fetch web url" }, makeCtx());
    const parsed = JSON.parse(String(res.content)) as {
      granted: string[];
    };
    expect(parsed.granted).toContain("web_fetch_x");
  });

  it("Agent hides deferred tools until search grants them", async () => {
    const tools = new ToolRegistry();
    tools.register(
      withExposure(
        {
          name: "hidden_fs",
          description: "filesystem search helper",
          parameters: z.object({}),
          async execute() {
            return { content: "x" };
          },
        },
        "deferred",
      ),
    );
    const seen: string[][] = [];
    const model: ModelAdapter = {
      async complete(input) {
        seen.push(input.tools.map((t) => t.name));
        if (seen.length === 1) {
          return {
            content: [
              {
                type: "tool_call",
                id: "1",
                name: "tool_search",
                args: { query: "filesystem" },
              },
            ],
            stopReason: "tool_use",
          };
        }
        return {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
        };
      },
    };
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      enableToolSearch: true,
    });
    await agent.run("go");
    expect(seen[0]).toContain("tool_search");
    expect(seen[0]).not.toContain("hidden_fs");
    expect(seen[1]).toContain("hidden_fs");
  });

  it("registers code_mode tools when enableCodeMode is true", () => {
    const agent = new Agent({
      model: {
        async complete() {
          return {
            content: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
          };
        },
      },
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      enableCodeMode: true,
    });
    expect(agent.tools.get("code_mode_exec")).toBeDefined();
    expect(agent.tools.get("code_mode_wait")).toBeDefined();
  });
});
