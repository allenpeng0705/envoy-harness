/**
 * Gap-closure end-to-end tests (Agent loop + scripted model).
 *
 * Complements peer-parity-e2e with surfaces from the "close all 10 gaps"
 * work that were only covered at the tool-constructor level.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  LocalMeshSubmitter,
  TeamJobRegistry,
  ToolRegistry,
  createLocalJobRegistry,
  defaultBuildSubagentFactory,
  newSessionId,
  type GuardianReviewer,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.js";

function text(t: string): ModelResponse["content"][number] {
  return { type: "text", text: t };
}

function toolCall(
  id: string,
  name: string,
  args: unknown,
): ModelResponse["content"][number] {
  return { type: "tool_call", id, name, args };
}

function scriptedModel(
  responses: ReadonlyArray<ModelResponse["content"]>,
): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const content = responses[i++] ?? [text("done")];
      const stopReason = content.some((b) => b.type === "tool_call")
        ? "tool_use"
        : "end_turn";
      return { content, stopReason };
    },
  };
}

function toolResults(agent: Agent): string[] {
  const out: string[] = [];
  for (const m of agent.session.messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push(
          typeof b.content === "string"
            ? b.content
            : JSON.stringify(b.content),
        );
      }
    }
  }
  return out;
}

async function until(
  label: string,
  cond: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const TASK_ARGS = {
  objective: "do the work",
  capability_tag: "research",
  cost_ceiling_usd: 0.5,
  deadline_ms: 30_000,
} as const;

describe("e2e: collaboration aliases lifecycle", () => {
  it("spawn_agent → followup_task → wait_agent(agent_id) → close_agent", async () => {
    const jobs = createLocalJobRegistry();
    const childModel = scriptedModel([
      [text("child-turn-1")],
      [text("child-turn-2")],
    ]);
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model: childModel }),
    });

    let agentId = "";
    let phase = 0;
    const parentModel: ModelAdapter = {
      async complete(req) {
        phase += 1;
        if (phase === 1) {
          return {
            content: [
              toolCall("t1", "spawn_agent", {
                ...TASK_ARGS,
                run_in_background: true,
                background_mode: "continuable",
              }),
            ],
            stopReason: "tool_use",
          };
        }
        for (const m of req.messages) {
          if (m.role !== "tool") continue;
          for (const b of m.content) {
            if (b.type !== "tool_result") continue;
            try {
              const parsed = JSON.parse(String(b.content)) as {
                agent_id?: string;
              };
              if (parsed.agent_id) agentId = parsed.agent_id;
            } catch {
              /* ignore */
            }
          }
        }
        if (phase === 2) {
          expect(agentId.length).toBeGreaterThan(0);
          return {
            content: [
              toolCall("t2", "followup_task", {
                agent_id: agentId,
                message: "please continue",
                delivery: "trigger",
              }),
            ],
            stopReason: "tool_use",
          };
        }
        if (phase === 3) {
          return {
            content: [
              toolCall("t3", "wait_agent", {
                agent_id: agentId,
                timeout_ms: 5_000,
              }),
            ],
            stopReason: "tool_use",
          };
        }
        if (phase === 4) {
          return {
            content: [
              toolCall("t4", "close_agent", {
                agent_id: agentId,
                reason: "done",
              }),
            ],
            stopReason: "tool_use",
          };
        }
        return { content: [text("parent done")], stopReason: "end_turn" };
      },
    };

    const agent = new Agent({
      model: parentModel,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: submitter,
      jobRegistry: jobs,
      subagentBackgroundMode: "continuable",
    });

    await agent.run("alias lifecycle");
    const results = toolResults(agent);
    expect(results.some((r) => r.includes("agent_id"))).toBe(true);
    expect(results.some((r) => r.includes('"delivery":"trigger"'))).toBe(true);
    expect(results.some((r) => r.includes("interrupted") || r.includes("close") || r.includes('"interrupted":true'))).toBe(
      true,
    );
    const kinds = (agent.session.events?.() ?? []).map((e) => e.kind);
    expect(kinds).toContain("child_spawn");
    await jobs.dispose();
  }, 20_000);
});

describe("e2e: wait_inbox while child runs", () => {
  it("host inject unblocks wait_inbox before child settles", async () => {
    const jobs = createLocalJobRegistry();
    let childComplete!: () => void;
    const childGate = new Promise<void>((r) => {
      childComplete = r;
    });
    const childModel: ModelAdapter = {
      async complete() {
        await childGate;
        return { content: [text("child-late")], stopReason: "end_turn" };
      },
    };
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model: childModel }),
    });

    let agent!: Agent;
    let phase = 0;
    const parentModel: ModelAdapter = {
      async complete() {
        phase += 1;
        if (phase === 1) {
          return {
            content: [
              toolCall("t1", "task", {
                ...TASK_ARGS,
                run_in_background: true,
                background_mode: "continuable",
              }),
            ],
            stopReason: "tool_use",
          };
        }
        if (phase === 2) {
          setTimeout(() => agent.inject("host steer"), 30);
          return {
            content: [
              toolCall("t2", "wait_inbox", { timeout_ms: 5_000 }),
            ],
            stopReason: "tool_use",
          };
        }
        return { content: [text("parent done")], stopReason: "end_turn" };
      },
    };

    agent = new Agent({
      model: parentModel,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: submitter,
      jobRegistry: jobs,
      subagentBackgroundMode: "continuable",
    });

    const runP = agent.run("wait inbox");
    await until("wait_inbox returned host text", () =>
      toolResults(agent).some((r) => r.includes("host steer")),
    );
    childComplete();
    await runP;
    expect(toolResults(agent).some((r) => r.includes("host steer"))).toBe(true);
    await jobs.dispose();
  }, 15_000);
});

describe("e2e: run_code orchestration", () => {
  it("model run_code invokes a registered tool in one turn", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        return { content: `echo:${(args as { text: string }).text}` };
      },
    });
    const model = scriptedModel([
      [
        toolCall("1", "run_code", {
          code: `return await tools.invoke("echo", { text: "via-ptc" });`,
        }),
      ],
      [text("done")],
    ]);
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      enableRunCode: true,
    });
    await agent.run("ptc");
    const raw = toolResults(agent).join("\n");
    expect(raw).toContain("via-ptc");
    expect(raw).toContain('"ok":true');
  });
});

describe("e2e: workflow via Agent.run", () => {
  it("model calls workflow parallel and gets aggregated JSON", async () => {
    const childModel = scriptedModel([[text("wf-child")]]);
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model: childModel }),
    });
    const model = scriptedModel([
      [
        toolCall("1", "workflow", {
          mode: "parallel",
          tasks: [
            {
              objective: "a",
              capability_tag: "research",
              cost_ceiling_usd: 0.2,
              deadline_ms: 10_000,
            },
            {
              objective: "b",
              capability_tag: "research",
              cost_ceiling_usd: 0.2,
              deadline_ms: 10_000,
            },
          ],
        }),
      ],
      [text("done")],
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: submitter,
    });
    await agent.run("workflow");
    const raw = toolResults(agent).join("\n");
    expect(raw).toContain('"mode":"parallel"');
    expect(raw).toContain("aggregated");
  }, 20_000);
});

describe("e2e: team board through model tools", () => {
  it("team_start → team_jobs → team_status", async () => {
    const registry = new TeamJobRegistry();
    let jobId = "";
    let phase = 0;
    const model: ModelAdapter = {
      async complete(req) {
        // Nested Team agents share this adapter but do not get team_* tools.
        const isParent = req.tools?.some((t) => t.name === "team_start");
        if (!isParent) {
          return { content: [text("team-agent-done")], stopReason: "end_turn" };
        }
        phase += 1;
        if (phase === 1) {
          return {
            content: [
              toolCall("1", "team_start", {
                config: {
                  name: "e2e-team",
                  agents: [
                    {
                      id: "w1",
                      role: "worker",
                      objective: "finish",
                      dependsOn: [],
                    },
                  ],
                },
              }),
            ],
            stopReason: "tool_use",
          };
        }
        for (const m of req.messages) {
          if (m.role !== "tool") continue;
          for (const b of m.content) {
            if (b.type !== "tool_result") continue;
            try {
              const parsed = JSON.parse(String(b.content)) as {
                job_id?: string;
              };
              if (parsed.job_id) jobId = parsed.job_id;
            } catch {
              /* ignore */
            }
          }
        }
        if (phase === 2) {
          return {
            content: [toolCall("2", "team_jobs", {})],
            stopReason: "tool_use",
          };
        }
        if (phase === 3) {
          return {
            content: [toolCall("3", "team_status", { job_id: jobId })],
            stopReason: "tool_use",
          };
        }
        return { content: [text("done")], stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      teamJobRegistry: registry,
    });
    await agent.run("team board");
    const raw = toolResults(agent).join("\n");
    expect(raw).toContain("e2e-team");
    expect(jobId.length).toBeGreaterThan(0);
    expect(raw).toContain(jobId);
    expect(registry.list()).toHaveLength(1);
  }, 20_000);
});

describe("e2e: Guardian blocks a tool batch", () => {
  it("blocked tool is not executed; model continues", async () => {
    let executed = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute() {
        executed += 1;
        return { content: "should-not-run" };
      },
    });
    const guardian: GuardianReviewer = {
      reviewToolBatch() {
        return { decision: "block", reason: "e2e-deny", score: 0.99 };
      },
    };
    const model = scriptedModel([
      [toolCall("1", "echo", { text: "x" })],
      [text("after block")],
    ]);
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
      guardian,
    });
    const result = await agent.run("guard");
    expect(executed).toBe(0);
    expect(toolResults(agent).some((r) => r.includes("guardian blocked"))).toBe(
      true,
    );
    expect(result.content.some((b) => b.type === "text" && b.text.includes("after block"))).toBe(
      true,
    );
  });
});

describe("e2e: work_budget second tool batch", () => {
  it("first batch runs; second batch is refused in the same turn", async () => {
    let executed = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        executed += 1;
        return { content: String((args as { text: string }).text) };
      },
    });
    const model = scriptedModel([
      [toolCall("1", "echo", { text: "a" })],
      [toolCall("2", "echo", { text: "b" })],
      [text("done")],
    ]);
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
      workBudget: 1,
    });
    await agent.run("budget");
    expect(executed).toBe(1);
    expect(
      toolResults(agent).some((r) => r.includes("work_budget exhausted")),
    ).toBe(true);
  });
});
