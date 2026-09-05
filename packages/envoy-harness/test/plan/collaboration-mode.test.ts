/**
 * R4.6 — collaboration mode tool policy + session wiring.
 */
import * as os from "node:os";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  InMemorySession,
  ToolRegistry,
  assembleTurnContext,
  collaborationModeBlockReason,
  collaborationModePrompt,
  createCollaborationModeState,
  filterToolNamesForMode,
  modeForcesReadOnly,
  newSessionId,
  type Tool,
} from "../../src/index.js";
import {
  FakeModel,
  textResponse,
  toolCall,
} from "../fixtures/fake-model.js";

describe("collaborationModeBlockReason", () => {
  it("allows everything in default", () => {
    expect(collaborationModeBlockReason("default", "write")).toBeUndefined();
    expect(collaborationModeBlockReason("default", "bash")).toBeUndefined();
  });

  it("blocks mutating tools in plan", () => {
    expect(collaborationModeBlockReason("plan", "write")).toMatch(/plan/);
    expect(collaborationModeBlockReason("plan", "edit")).toMatch(/plan/);
    expect(collaborationModeBlockReason("plan", "task")).toMatch(/plan/);
    expect(collaborationModeBlockReason("plan", "read_file")).toBeUndefined();
    expect(collaborationModeBlockReason("plan", "bash")).toBeUndefined();
  });

  it("blocks non-allowlisted tools in review", () => {
    expect(collaborationModeBlockReason("review", "write")).toMatch(/review/);
    expect(collaborationModeBlockReason("review", "read_file")).toBeUndefined();
    expect(collaborationModeBlockReason("review", "job_list")).toMatch(/review/);
    expect(
      collaborationModeBlockReason("review", "mcp__server__tool"),
    ).toBeUndefined();
  });

  it("filters tool name lists", () => {
    expect(
      filterToolNamesForMode(["write", "read_file", "bash"], "plan"),
    ).toEqual(["read_file", "bash"]);
  });

  it("forces read-only for plan and review", () => {
    expect(modeForcesReadOnly("plan")).toBe(true);
    expect(modeForcesReadOnly("review")).toBe(true);
    expect(modeForcesReadOnly("default")).toBe(false);
  });
});

describe("collaborationModePrompt", () => {
  it("returns guidance only for plan/review", () => {
    expect(collaborationModePrompt("default")).toBeUndefined();
    expect(collaborationModePrompt("plan")).toContain("PLAN");
    expect(collaborationModePrompt("review")).toContain("REVIEW");
  });
});

describe("assembleTurnContext + mode", () => {
  it("injects collaboration mode fragment", async () => {
    const ctx = await assembleTurnContext({
      cwd: process.cwd(),
      signal: AbortSignal.timeout(5_000),
      collaborationMode: "plan",
    });
    expect(ctx.text).toContain("COLLABORATION MODE: PLAN");
    expect(ctx.included).toContain("collaboration-mode");
  });
});

const writeTool: Tool = {
  name: "write",
  description: "write",
  parameters: z.object({
    path: z.string(),
    content: z.string(),
  }),
  async execute() {
    throw new Error("write should not run");
  },
};

const readTool: Tool = {
  name: "read_file",
  description: "read",
  parameters: z.object({ path: z.string() }),
  async execute() {
    return { content: "ok" };
  },
};

describe("Agent.setCollaborationMode", () => {
  it("stores and restores permission mode around plan", () => {
    const session = new InMemorySession(newSessionId(), {
      cwd: os.tmpdir(),
      startedAt: new Date().toISOString(),
      permissionMode: "workspace-write",
    });
    const tools = new ToolRegistry();
    const agent = new Agent({
      model: new FakeModel([textResponse("ok")]),
      tools,
      session,
      cwd: os.tmpdir(),
    });
    expect(agent.getPermissionMode()).toBe("workspace-write");
    agent.setCollaborationMode("plan");
    expect(agent.getCollaborationMode()).toBe("plan");
    expect(session.getCollaborationMode().kind).toBe("plan");
    expect(session.getCollaborationMode().previousPermissionMode).toBe(
      "workspace-write",
    );
    agent.setCollaborationMode("default");
    expect(agent.getCollaborationMode()).toBe("default");
    expect(agent.getPermissionMode()).toBe("workspace-write");
  });

  it("hides write from the model and blocks execute in plan mode", async () => {
    const session = new InMemorySession(newSessionId(), {
      cwd: os.tmpdir(),
      startedAt: new Date().toISOString(),
      permissionMode: "workspace-write",
      collaborationMode: createCollaborationModeState("plan"),
    });
    const model = new FakeModel([
      {
        content: [
          toolCall("c1", "write", { path: "x.txt", content: "nope" }),
        ],
      },
      textResponse("done"),
    ]);
    const tools = new ToolRegistry();
    tools.register(writeTool);
    tools.register(readTool);
    const agent = new Agent({
      model,
      tools,
      session,
      cwd: os.tmpdir(),
    });
    const result = await agent.run("try write");
    expect(model.calls[0]?.tools.map((t) => t.name)).not.toContain("write");
    expect(model.calls[0]?.tools.map((t) => t.name)).toContain("read_file");
    const toolResults = session.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result"),
    );
    expect(
      toolResults.some(
        (b) =>
          b.type === "tool_result" &&
          typeof b.content === "string" &&
          b.content.includes("collaboration mode"),
      ),
    ).toBe(true);
    expect(result.stopReason).toBe("end_turn");
  });
});
