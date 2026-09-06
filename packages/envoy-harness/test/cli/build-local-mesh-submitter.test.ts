/**
 * R8.1 — CLI LocalMeshSubmitter wiring.
 */

import { describe, expect, it } from "vitest";

import { Agent } from "../../src/agent.js";
import { InMemorySession, newSessionId } from "../../src/session.js";
import { ToolRegistry } from "../../src/tools/index.js";
import { HookRegistry } from "../../src/hooks/index.js";
import { buildCliLocalMeshSubmitter } from "../../src/cli/run/build-local-mesh-submitter.js";
import { parseArgs } from "../../src/cli/argv.js";

const fakeModel = {
  id: "test",
  async complete() {
    return { content: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  },
};

describe("buildCliLocalMeshSubmitter", () => {
  it("registers task on Agent when meshSubmitter is wired", () => {
    const tools = new ToolRegistry();
    const submitter = buildCliLocalMeshSubmitter({
      model: fakeModel as never,
      cwd: process.cwd(),
    });
    const agent = new Agent({
      model: fakeModel as never,
      tools,
      hooks: new HookRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: process.cwd(),
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      cwd: process.cwd(),
      meshSubmitter: submitter,
    });
    expect(agent.tools.list().some((t) => t.name === "task")).toBe(true);
    expect(agent.getMeshSubmitter()).toBe(submitter);
  });

  it("does not register task without meshSubmitter", () => {
    const agent = new Agent({
      model: fakeModel as never,
      tools: new ToolRegistry(),
      hooks: new HookRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: process.cwd(),
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      cwd: process.cwd(),
    });
    expect(agent.tools.list().some((t) => t.name === "task")).toBe(false);
  });
});

describe("parseArgs --no-subagents", () => {
  it("defaults noSubagents to false", () => {
    const parsed = parseArgs(["hello"]);
    expect(parsed.subcommand).toBe("run");
    if (parsed.subcommand === "run") {
      expect(parsed.noSubagents).toBe(false);
    }
  });

  it("sets noSubagents when flag present", () => {
    const parsed = parseArgs(["--no-subagents", "hello"]);
    expect(parsed.subcommand).toBe("run");
    if (parsed.subcommand === "run") {
      expect(parsed.noSubagents).toBe(true);
    }
  });
});
