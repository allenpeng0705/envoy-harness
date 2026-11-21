/**
 * Peer-harness parity end-to-end tests.
 *
 * These drive the full Agent loop (scripted model → tools → transcript /
 * settlement followup) for the DeepSeek/Codex parity surfaces. Hermetic —
 * no network, no real LLM.
 *
 * Covers:
 * 1. job_start → real shell settle → Job settled notice → followup wake
 * 2. background task → Sub-agent settled notice → followup (not Job settled)
 * 3. job_output wait:true collects result without a duplicate settle notice
 * 4. mixed parallel tools in one assistant turn (task + read_file)
 * 5. continuable child: send_message queue then trigger through Agent tools
 * 6. wake budget exhaust → host run resets and drains
 * 7. child inherits live parent permission via factory getters
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  LocalMeshSubmitter,
  ToolRegistry,
  createLocalJobRegistry,
  defaultBuildSubagentFactory,
  newSessionId,
  readFileTool,
  registerJobTools,
  type ModelAdapter,
  type ModelResponse,
  type PermissionMode,
} from "../src/index.js";
import { policyFromMode } from "../src/permissions/policy.js";
import {
  JOB_SETTLEMENT_NOTICE_PREFIX,
  SETTLEMENT_NOTICE_PREFIX,
} from "../src/subagent/settlement-notice.js";

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

function countingModel(
  responses: ReadonlyArray<ModelResponse["content"]>,
): { model: ModelAdapter; getCalls: () => number } {
  let calls = 0;
  let i = 0;
  return {
    getCalls: () => calls,
    model: {
      async complete() {
        calls += 1;
        const content = responses[i++] ?? [text(`auto-${calls}`)];
        const stopReason = content.some((b) => b.type === "tool_call")
          ? "tool_use"
          : "end_turn";
        return { content, stopReason };
      },
    },
  };
}

function userTexts(agent: Agent): string[] {
  return agent.session.messages
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text),
    );
}

function toolResultContents(agent: Agent): string[] {
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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "peer-parity-e2e-"));
  await fs.writeFile(path.join(tmpDir, "notes.txt"), "parity-notes\n");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("e2e: bash job settle → followup wake", () => {
  it("job_start settles, parent sees Job settled notice, followup runs", async () => {
    const jobs = createLocalJobRegistry();
    const { model, getCalls } = countingModel([
      [
        toolCall("t1", "job_start", {
          command: "printf 'shell-done'",
          label: "echo-job",
        }),
      ],
      [text("acknowledged primary")],
      // Settlement followup turn after idle settle.
      [text("saw the job settle")],
    ]);
    const tools = new ToolRegistry();
    registerJobTools(tools, jobs);
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      cwd: tmpDir,
      systemPrompt: "test",
      jobRegistry: jobs,
      settlementFollowup: true,
      maxConsecutiveSettlementWakes: 3,
    });

    await agent.run("start a background job");
    await until("job settle notice in transcript or followup", () => {
      const texts = userTexts(agent).join("\n");
      return (
        texts.includes(JOB_SETTLEMENT_NOTICE_PREFIX) ||
        agent.pendingSettlementNotices.some((n) =>
          n.includes(JOB_SETTLEMENT_NOTICE_PREFIX),
        )
      );
    });
    // Followup may still be in flight — wait for an extra model call.
    await until("settlement followup model call", () => getCalls() >= 3);

    const all = userTexts(agent).join("\n");
    expect(all).toContain(JOB_SETTLEMENT_NOTICE_PREFIX);
    expect(all).toMatch(/echo-job|bash-/);
    expect(all).not.toContain(SETTLEMENT_NOTICE_PREFIX);

    const assistants = agent.session.messages.filter((m) => m.role === "assistant");
    expect(
      assistants.some((m) =>
        m.content.some(
          (b) => b.type === "text" && String(b.text).includes("saw the job settle"),
        ),
      ),
    ).toBe(true);

    await jobs.dispose();
  }, 15_000);
});

describe("e2e: background sub-agent settle → followup", () => {
  it("background task delivers Sub-agent settled notice and wakes parent", async () => {
    const jobs = createLocalJobRegistry();
    // Delay the child so settle lands after the parent primary turn ends
    // (idle followup path), not mid-turn flush.
    const childModel: ModelAdapter = {
      async complete() {
        await new Promise((r) => setTimeout(r, 80));
        return {
          content: [text("child-finished")],
          stopReason: "end_turn",
        };
      },
    };
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model: childModel }),
    });
    const { model, getCalls } = countingModel([
      [
        toolCall("t1", "task", {
          ...TASK_ARGS,
          run_in_background: true,
        }),
      ],
      [text("parent continuing")],
      [text("followup after child")],
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      cwd: tmpDir,
      systemPrompt: "test",
      meshSubmitter: submitter,
      jobRegistry: jobs,
      settlementFollowup: true,
    });

    await agent.run("spawn background child");
    await until("sub-agent settle notice", () => {
      const texts = [
        ...userTexts(agent),
        ...agent.pendingSettlementNotices,
      ].join("\n");
      return texts.includes(SETTLEMENT_NOTICE_PREFIX);
    });
    await until("followup after background settle", () => getCalls() >= 3);

    const all = [
      ...userTexts(agent),
      ...agent.pendingSettlementNotices,
    ].join("\n");
    expect(all).toContain(SETTLEMENT_NOTICE_PREFIX);
    expect(all).toContain("child-finished");
    expect(all).not.toContain(JOB_SETTLEMENT_NOTICE_PREFIX);

    await jobs.dispose();
  }, 15_000);
});

describe("e2e: job_output wait dedups settle notice", () => {
  it("wait:true returns the result and does not also push a settle notice", async () => {
    const jobs = createLocalJobRegistry();
    let jobId = "";
    // Dynamic model that reads the job id from the prior tool result.
    let phase = 0;
    const dynamic: ModelAdapter = {
      async complete(req) {
        phase += 1;
        if (phase === 1) {
          return {
            content: [
              toolCall("t1", "job_start", {
                command: "printf 'waited-out'",
                label: "wait-me",
              }),
            ],
            stopReason: "tool_use",
          };
        }
        if (phase === 2) {
          // Find job id from transcript tool results.
          for (const m of req.messages) {
            if (m.role !== "tool") continue;
            for (const b of m.content) {
              if (b.type !== "tool_result") continue;
              try {
                const parsed = JSON.parse(String(b.content)) as { id?: string };
                if (typeof parsed.id === "string") jobId = parsed.id;
              } catch {
                /* ignore */
              }
            }
          }
          expect(jobId.length).toBeGreaterThan(0);
          return {
            content: [
              toolCall("t2", "job_output", {
                id: jobId,
                wait: true,
                timeout_ms: 5_000,
              }),
            ],
            stopReason: "tool_use",
          };
        }
        return {
          content: [text("got wait result")],
          stopReason: "end_turn",
        };
      },
    };

    const tools = new ToolRegistry();
    registerJobTools(tools, jobs);
    const agent = new Agent({
      model: dynamic,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      cwd: tmpDir,
      systemPrompt: "test",
      jobRegistry: jobs,
      settlementFollowup: false,
    });

    await agent.run("wait for the job");
    const results = toolResultContents(agent);
    expect(results.some((r) => r.includes("waited-out") || r.includes("completed"))).toBe(
      true,
    );
    // Waited settle must not also leave a Job settled notice queued.
    expect(
      agent.pendingSettlementNotices.some((n) =>
        n.includes(JOB_SETTLEMENT_NOTICE_PREFIX),
      ),
    ).toBe(false);
    expect(
      userTexts(agent).some((t) => t.includes(JOB_SETTLEMENT_NOTICE_PREFIX)),
    ).toBe(false);

    await jobs.dispose();
  }, 15_000);
});

describe("e2e: mixed parallel tools in one turn", () => {
  it("runs task + read_file concurrently and commits in model order", async () => {
    const filePath = path.join(tmpDir, "notes.txt");
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let waiting = 0;

    const childModel = scriptedModel([[text("task-ok")]]);
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model: childModel }),
    });

    // Wrap read_file to observe overlap with task.
    const tools = new ToolRegistry();
    tools.register({
      ...readFileTool,
      async execute(args, ctx) {
        started.push("read_file");
        waiting += 1;
        if (waiting === 2) release();
        await gate;
        return readFileTool.execute(args as never, ctx);
      },
    });

    // Intercept task via a second model path: the real task tool from Agent
    // registration — we observe start by wrapping submitter.
    const baseSubmit = submitter.submit.bind(submitter);
    submitter.submit = async (input, signal) => {
      started.push("task");
      waiting += 1;
      if (waiting === 2) release();
      await gate;
      return baseSubmit(input, signal);
    };

    const parentModel = scriptedModel([
      [
        toolCall("t1", "task", { ...TASK_ARGS, objective: "parallel-a" }),
        toolCall("t2", "read_file", { path: filePath }),
      ],
      [text("both done")],
    ]);

    const agent = new Agent({
      model: parentModel,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      cwd: tmpDir,
      systemPrompt: "test",
      meshSubmitter: submitter,
    });

    await agent.run("fan out");
    expect(started.sort()).toEqual(["read_file", "task"]);
    const results = toolResultContents(agent);
    expect(results[0]).toMatch(/task-ok|42|completed|status/i);
    expect(results[1]).toContain("parity-notes");
  }, 15_000);
});

describe("e2e: continuable send_message delivery modes", () => {
  it("queue parks the child; trigger wakes it through Agent tools", async () => {
    const jobs = createLocalJobRegistry();
    const childModel = scriptedModel([
      [text("turn-one")],
      [text("turn-two")],
      [text("turn-three")],
    ]);
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model: childModel }),
    });

    let agentId = "";
    let jobId = "";
    let phase = 0;
    const model: ModelAdapter = {
      async complete(req) {
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
        // Parse ids from tool results.
        for (const m of req.messages) {
          if (m.role !== "tool") continue;
          for (const b of m.content) {
            if (b.type !== "tool_result") continue;
            try {
              const parsed = JSON.parse(String(b.content)) as {
                agent_id?: string;
                job_id?: string;
              };
              if (parsed.agent_id) agentId = parsed.agent_id;
              if (parsed.job_id) jobId = parsed.job_id;
            } catch {
              /* ignore */
            }
          }
        }
        if (phase === 2) {
          expect(agentId.length).toBeGreaterThan(0);
          return {
            content: [
              toolCall("t2", "send_message", {
                agent_id: agentId,
                message: "queued followup",
                delivery: "queue",
              }),
            ],
            stopReason: "tool_use",
          };
        }
        if (phase === 3) {
          return {
            content: [
              toolCall("t3", "send_message", {
                agent_id: agentId,
                message: "wake now",
                delivery: "trigger",
              }),
            ],
            stopReason: "tool_use",
          };
        }
        return {
          content: [text("steered")],
          stopReason: "end_turn",
        };
      },
    };

    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      cwd: tmpDir,
      systemPrompt: "test",
      meshSubmitter: submitter,
      jobRegistry: jobs,
      subagentBackgroundMode: "continuable",
    });

    const runP = agent.run("steer child");
    await until("child turn one", () => {
      // Prefer non-consuming handle.output(): jobs.read advances a cursor and
      // can swallow later turns that arrive in the same poll window.
      if (agentId.length > 0) {
        const out = submitter.getHandle?.(agentId)?.output() ?? "";
        return out.includes("turn-one");
      }
      const snaps = jobs.list(agent.session.id);
      const bg = snaps.find((s) => s.kind === "subagent");
      if (bg === undefined) return false;
      jobId = bg.id;
      // agent_id === handle id for continuable children
      const handles = submitter.listSubagents?.() ?? [];
      const rec = handles.find((h) => h.status === "running");
      if (rec !== undefined) agentId = rec.sessionId;
      const out = submitter.getHandle?.(agentId)?.output() ?? "";
      return out.includes("turn-one");
    });
    await runP;

    const sendResults = toolResultContents(agent).filter((r) => {
      try {
        const p = JSON.parse(r) as { delivery?: string };
        return p.delivery === "queue" || p.delivery === "trigger";
      } catch {
        return false;
      }
    });
    expect(sendResults.some((r) => r.includes('"delivery":"queue"'))).toBe(
      true,
    );
    expect(sendResults.some((r) => r.includes('"delivery":"trigger"'))).toBe(
      true,
    );

    await until("child woke for turn-two", () => {
      if (agentId.length === 0) return false;
      return (submitter.getHandle?.(agentId)?.output() ?? "").includes(
        "turn-two",
      );
    });

    jobs.kill(jobId, agent.session.id, "done");
    await jobs.wait(jobId, 5_000, agent.session.id).catch(() => undefined);
    await jobs.dispose();
  }, 20_000);
});

describe("e2e: wake budget then host turn", () => {
  it("stops auto-wakes at the budget then drains on the next host run", async () => {
    const jobs = createLocalJobRegistry();
    const { model, getCalls } = countingModel([
      [
        toolCall("t1", "job_start", {
          command: "printf 'a'",
          label: "a",
        }),
      ],
      [text("primary done")],
      [text("wake-1")],
      // Host turn after budget exhaust.
      [text("host drained")],
    ]);
    const tools = new ToolRegistry();
    registerJobTools(tools, jobs);
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      cwd: tmpDir,
      systemPrompt: "test",
      jobRegistry: jobs,
      settlementFollowup: true,
      maxConsecutiveSettlementWakes: 1,
    });

    await agent.run("start");
    await until("first settle wake", () => getCalls() >= 3, 8_000);

    // Fire two more settles while budget is exhausted.
    agent.enqueueSettlementNotice(`${JOB_SETTLEMENT_NOTICE_PREFIX} extra-1`);
    agent.enqueueSettlementNotice(`${JOB_SETTLEMENT_NOTICE_PREFIX} extra-2`);
    await new Promise((r) => setTimeout(r, 40));
    const callsAfterBudget = getCalls();
    expect(agent.pendingSettlementNotices.length).toBeGreaterThanOrEqual(1);

    await agent.run("human follow-up");
    expect(getCalls()).toBeGreaterThan(callsAfterBudget);
    const texts = userTexts(agent).join("\n");
    expect(texts).toMatch(/extra-1|extra-2/);

    await jobs.dispose();
  }, 15_000);
});

describe("e2e: child permission inherit", () => {
  it("spawns children with the live parent permission mode", async () => {
    const modes: PermissionMode[] = [];
    let liveMode: PermissionMode = "workspace-write";
    const childModel = scriptedModel([[text("ok")]]);
    const factory = defaultBuildSubagentFactory({
      model: childModel,
      permissionMode: "read-only",
      getPermissionMode: () => liveMode,
      getSandboxPolicy: () => policyFromMode(liveMode, tmpDir),
    });
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: (input) => {
        const child = factory(input);
        modes.push(child.getPermissionMode());
        return child;
      },
    });

    const parentModel = scriptedModel([
      [
        toolCall("t1", "task", {
          ...TASK_ARGS,
          objective: "inherit-check",
        }),
      ],
      [text("done")],
    ]);
    const agent = new Agent({
      model: parentModel,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      cwd: tmpDir,
      systemPrompt: "test",
      meshSubmitter: submitter,
    });

    await agent.run("spawn");
    expect(modes).toEqual(["workspace-write"]);

    liveMode = "read-only";
    const parentModel2 = scriptedModel([
      [
        toolCall("t2", "task", {
          ...TASK_ARGS,
          objective: "inherit-check-2",
        }),
      ],
      [text("done-2")],
    ]);
    // Swap model for second run on same agent.
    agent.setModel(parentModel2);
    await agent.run("spawn again");
    expect(modes).toEqual(["workspace-write", "read-only"]);
  }, 15_000);
});
