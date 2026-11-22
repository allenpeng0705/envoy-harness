/**
 * High-value workflow e2e — product paths that unit tests miss:
 * ACP multi-step + resume, mid-task permission recovery, plan approve→ship,
 * undo after a bad patch, and compaction continuity during a fix.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  SessionStore,
  ToolRegistry,
  applyPatchTool,
  bashTool,
  installToolPermissionAskHook,
  newSessionId,
  readFileTool,
  writeTool,
} from "../src/index.js";
import {
  attachAcpServer,
  createAgentSessionBackend,
  createInProcessJsonRpcPair,
} from "../src/protocol/index.js";
import { FakeModel, textResponse, toolCall } from "./fixtures/fake-model.js";

let tmpDir: string;
let storeDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-valuable-"));
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-sess-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(storeDir, { recursive: true, force: true });
});

function fsTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(readFileTool);
  tools.register(writeTool);
  tools.register(applyPatchTool);
  tools.register(bashTool);
  return tools;
}

function toolTexts(agent: Agent): string[] {
  const out: string[] = [];
  for (const m of agent.session.messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push(
          typeof b.content === "string" ? b.content : JSON.stringify(b.content),
        );
      }
    }
  }
  return out;
}

describe("e2e: ACP multi-step task + session/load resume", () => {
  it("fixes a bug over JSON-RPC, persists, resumes, and continues", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "add.js"),
      "export function add(a, b) { return a - b; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "check.mjs"),
      [
        "import { add } from './add.js';",
        "if (add(2, 3) !== 5) { console.error('FAIL'); process.exit(1); }",
        "console.log('PASS');",
        "",
      ].join("\n"),
      "utf8",
    );

    // Shared scripted model across create + load (new Agent, same model).
    const model = new FakeModel([
      {
        content: [
          toolCall("t1", "read_file", {
            path: path.join(tmpDir, "src", "add.js"),
          }),
        ],
      },
      {
        content: [
          toolCall("t2", "apply_patch", {
            patch: `*** Begin Patch
*** Update File: src/add.js
-export function add(a, b) { return a - b; }
+export function add(a, b) { return a + b; }
*** End Patch`,
          }),
        ],
      },
      {
        content: [toolCall("t3", "bash", { command: "node src/check.mjs" })],
      },
      textResponse("Fixed add() and verified PASS."),
      // After resume:
      {
        content: [
          toolCall("t4", "read_file", {
            path: path.join(tmpDir, "src", "add.js"),
          }),
        ],
      },
      textResponse("After resume: add() still returns a + b."),
    ]);

    const store = new SessionStore({ dir: storeDir });
    const makeBackend = () =>
      createAgentSessionBackend({
        defaultCwd: tmpDir,
        sessionStore: store,
        // Without this, live permission hook defaults to ask-all and ACP
        // denies when the host has no request_permission handler.
        initialAutoRun: "off",
        createAgent: ({ sessionId, cwd, session, askHandler }) =>
          new Agent({
            model,
            tools: fsTools(),
            hooks: new HookRegistry(),
            session:
              session ??
              new InMemorySession(sessionId, {
                cwd: cwd ?? tmpDir,
                permissionMode: "workspace-write",
                startedAt: new Date().toISOString(),
              }),
            cwd: cwd ?? tmpDir,
            ...(askHandler !== undefined ? { askHandler } : {}),
          }),
      });

    const backend = makeBackend();
    const pair = createInProcessJsonRpcPair();
    const dispose = attachAcpServer({
      connection: pair.server,
      backend,
    });
    pair.client.setRequestHandler(async (method) => {
      if (method === "session/request_permission") {
        return { decision: "allow" };
      }
      throw new Error(`unexpected host request ${method}`);
    });

    try {
      await pair.client.request("initialize", {});
      const { sessionId } = (await pair.client.request("session/new", {
        cwd: tmpDir,
      })) as { sessionId: string };

      const first = (await pair.client.request("session/prompt", {
        sessionId,
        prompt: { text: "Fix add(2,3) and verify." },
      })) as { stopReason: string };
      expect(first.stopReason).toBe("end_turn");

      const fixed = await fs.readFile(
        path.join(tmpDir, "src", "add.js"),
        "utf8",
      );
      expect(fixed).toContain("a + b");

      await store.load(sessionId); // durability: exists
      const persisted = await store.load(sessionId);
      expect(persisted.messages.length).toBeGreaterThan(4);

      // New host connection + loadSession resumes the same id.
      dispose();
      const pair2 = createInProcessJsonRpcPair();
      const backend2 = makeBackend();
      const dispose2 = attachAcpServer({
        connection: pair2.server,
        backend: backend2,
      });
      pair2.client.setRequestHandler(async (method) => {
        if (method === "session/request_permission") {
          return { decision: "allow" };
        }
        throw new Error(`unexpected host request ${method}`);
      });
      try {
        await pair2.client.request("initialize", {});
        const loaded = (await pair2.client.request("session/load", {
          sessionId,
        })) as { sessionId: string };
        expect(loaded.sessionId).toBe(sessionId);

        const second = (await pair2.client.request("session/prompt", {
          sessionId,
          prompt: { text: "Confirm the fix is still on disk." },
        })) as {
          stopReason: string;
          messages?: Array<{ text?: string }>;
        };
        expect(second.stopReason).toBe("end_turn");
        const reply =
          second.messages?.map((m) => m.text ?? "").join(" ") ?? "";
        expect(reply).toMatch(/After resume/i);

        // Resume prompt saw prior history (model call after first 4).
        expect(model.calls.length).toBeGreaterThanOrEqual(5);
        const resumeInput = JSON.stringify(model.calls[4]?.messages ?? []);
        expect(resumeInput).toMatch(/Fixed add|PASS|a \+ b/i);
      } finally {
        dispose2();
      }
    } finally {
      try {
        dispose();
      } catch {
        /* already disposed */
      }
    }
  });
});

describe("e2e: permission deny then recover same turn", () => {
  it("denied bash → read_file succeeds → task completes", async () => {
    await fs.writeFile(
      path.join(tmpDir, "secret.txt"),
      "token=open-sesame\n",
      "utf8",
    );

    const hooks = new HookRegistry();
    installToolPermissionAskHook(hooks, {
      shouldAsk: (tool) => tool === "bash",
    });

    let deniedBash = false;
    const model = new FakeModel([
      {
        content: [
          toolCall("t1", "bash", {
            command: `cat ${path.join(tmpDir, "secret.txt")}`,
          }),
        ],
      },
      {
        content: [
          toolCall("t2", "read_file", {
            path: path.join(tmpDir, "secret.txt"),
          }),
        ],
      },
      textResponse("Recovered via read_file; token is open-sesame."),
    ]);

    const agent = new Agent({
      model,
      tools: fsTools(),
      hooks,
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      cwd: tmpDir,
      askHandler: async (req) => {
        if (req.tool === "bash") {
          deniedBash = true;
          return { kind: "deny", reason: "bash blocked by host policy" };
        }
        return { kind: "allow" };
      },
    });

    const result = await agent.run("Read the secret without shell if blocked.");
    expect(result.stopReason).toBe("end_turn");
    expect(deniedBash).toBe(true);
    expect(result.toolCalls).toBe(2);

    const results = toolTexts(agent);
    expect(results[0]).toMatch(/denied|block|permission|reject/i);
    expect(results.some((r) => r.includes("open-sesame"))).toBe(true);
    expect(
      (result.content[0] as { text: string }).text,
    ).toMatch(/Recovered via read_file/i);
  });
});

describe("e2e: plan approve then execute", () => {
  it("ACP plan enter→edit→propose→approve then write ships", async () => {
    const model = new FakeModel([
      // After approve — execute the plan.
      {
        content: [
          toolCall("t1", "write", {
            path: "SHIPPED.txt",
            content: "plan-executed\n",
            createDirectories: true,
          }),
        ],
      },
      textResponse("Shipped per approved plan."),
    ]);

    const backend = createAgentSessionBackend({
      defaultCwd: tmpDir,
      initialAutoRun: "off",
      createAgent: ({ sessionId, cwd, session, askHandler }) =>
        new Agent({
          model,
          tools: fsTools(),
          hooks: new HookRegistry(),
          session:
            session ??
            new InMemorySession(sessionId, {
              cwd: cwd ?? tmpDir,
              permissionMode: "workspace-write",
              startedAt: new Date().toISOString(),
            }),
          cwd: cwd ?? tmpDir,
          ...(askHandler !== undefined ? { askHandler } : {}),
        }),
    });

    const pair = createInProcessJsonRpcPair();
    const dispose = attachAcpServer({
      connection: pair.server,
      backend,
    });
    pair.client.setRequestHandler(async (method) => {
      if (method === "session/request_permission") {
        return { decision: "allow" };
      }
      throw new Error(`unexpected host request ${method}`);
    });

    try {
      await pair.client.request("initialize", {});
      const { sessionId } = (await pair.client.request("session/new", {
        cwd: tmpDir,
      })) as { sessionId: string };

      const enter = (await pair.client.request("session/plan", {
        sessionId,
        action: "enter",
      })) as { output: string };
      expect(enter.output).toMatch(/entered/i);

      await pair.client.request("session/plan", {
        sessionId,
        action: "edit",
        text: "Write SHIPPED.txt with body plan-executed",
      });
      await pair.client.request("session/plan", {
        sessionId,
        action: "propose",
      });
      const approved = (await pair.client.request("session/plan", {
        sessionId,
        action: "approve",
      })) as { output: string };
      expect(approved.output).toMatch(/approved/i);

      const prompt = (await pair.client.request("session/prompt", {
        sessionId,
        prompt: { text: "Implement the approved plan." },
      })) as { stopReason: string };
      expect(prompt.stopReason).toBe("end_turn");

      const body = await fs.readFile(
        path.join(tmpDir, "SHIPPED.txt"),
        "utf8",
      );
      expect(body).toBe("plan-executed\n");

      // Model saw the approved plan contingency / plan text.
      const firstCall = JSON.stringify(model.calls[0]?.messages ?? []);
      expect(firstCall).toMatch(/SHIPPED|plan-executed|ACTIVE PLAN|approved/i);
    } finally {
      dispose();
    }
  });

  it("write is blocked in plan mode before approve", async () => {
    const model = new FakeModel([
      {
        content: [
          toolCall("t1", "write", {
            path: "blocked.txt",
            content: "nope\n",
          }),
        ],
      },
      textResponse("Could not write while still in plan mode."),
    ]);

    const agent = new Agent({
      model,
      tools: fsTools(),
      hooks: new HookRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      cwd: tmpDir,
    });
    agent.setCollaborationMode("plan");

    const result = await agent.run("try to write");
    expect(result.stopReason).toBe("end_turn");
    expect(toolTexts(agent)[0]).toMatch(/plan/i);
    await expect(
      fs.readFile(path.join(tmpDir, "blocked.txt"), "utf8"),
    ).rejects.toThrow();
  });
});

describe("e2e: bad patch → undo → correct fix", () => {
  it("host undo restores file then agent ships the right patch", async () => {
    await fs.writeFile(
      path.join(tmpDir, "rate.js"),
      "export const RATE = 0.1;\n",
      "utf8",
    );

    const modelBad = new FakeModel([
      {
        content: [
          toolCall("b1", "apply_patch", {
            patch: `*** Begin Patch
*** Update File: rate.js
-export const RATE = 0.1;
+export const RATE = 9.9;
*** End Patch`,
          }),
        ],
      },
      textResponse("Applied provisional rate."),
    ]);

    const agent = new Agent({
      model: modelBad,
      tools: fsTools(),
      hooks: new HookRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      cwd: tmpDir,
    });

    await agent.run("Set RATE wrong on purpose");
    expect(await fs.readFile(path.join(tmpDir, "rate.js"), "utf8")).toContain(
      "9.9",
    );
    expect(agent.canUndo()).toBe(true);

    const undone = await agent.undoLastFileChange();
    expect(undone.action).toBe("restored");
    expect(await fs.readFile(path.join(tmpDir, "rate.js"), "utf8")).toBe(
      "export const RATE = 0.1;\n",
    );

    // Swap model for the corrective turn (same session/agent).
    const modelGood = new FakeModel([
      {
        content: [
          toolCall("g1", "apply_patch", {
            patch: `*** Begin Patch
*** Update File: rate.js
-export const RATE = 0.1;
+export const RATE = 0.2;
*** End Patch`,
          }),
        ],
      },
      {
        content: [
          toolCall("g2", "bash", {
            command:
              "node -e \"import('./rate.js').then(m=>{if(m.RATE!==0.2)process.exit(1);console.log('PASS');})\"",
          }),
        ],
      },
      textResponse("Correct RATE=0.2 after undo."),
    ]);
    // Agent.model is private — rebuild with same session.
    const agent2 = new Agent({
      model: modelGood,
      tools: fsTools(),
      hooks: new HookRegistry(),
      session: agent.session,
      cwd: tmpDir,
    });
    const result = await agent2.run("Apply the correct RATE and verify.");
    expect(result.stopReason).toBe("end_turn");
    expect(await fs.readFile(path.join(tmpDir, "rate.js"), "utf8")).toContain(
      "0.2",
    );
    expect(toolTexts(agent2).some((r) => r.includes("PASS"))).toBe(true);
  });
});

describe("e2e: compact mid-task then finish the fix", () => {
  it("after compactWithSummary the agent still patches and verifies", async () => {
    await fs.mkdir(path.join(tmpDir, "pkg"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "pkg", "util.js"),
      "export function twice(n) { return n; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "pkg", "check.mjs"),
      [
        "import { twice } from './util.js';",
        "if (twice(3) !== 6) { console.error('FAIL', twice(3)); process.exit(1); }",
        "console.log('PASS');",
        "",
      ].join("\n"),
      "utf8",
    );

    const model = new FakeModel([
      // Turn 1 — explore (creates history to compact).
      {
        content: [
          toolCall("t1", "read_file", {
            path: path.join(tmpDir, "pkg", "util.js"),
          }),
        ],
      },
      {
        content: [
          toolCall("t2", "read_file", {
            path: path.join(tmpDir, "pkg", "check.mjs"),
          }),
        ],
      },
      textResponse("Diagnosed: twice() returns n instead of 2*n."),
      // Turn 2 — after compact.
      {
        content: [
          toolCall("t3", "apply_patch", {
            patch: `*** Begin Patch
*** Update File: pkg/util.js
-export function twice(n) { return n; }
+export function twice(n) { return n * 2; }
*** End Patch`,
          }),
        ],
      },
      {
        content: [toolCall("t4", "bash", { command: "node pkg/check.mjs" })],
      },
      textResponse("Fixed twice() after compaction; check PASS."),
    ]);

    const agent = new Agent({
      model,
      tools: fsTools(),
      hooks: new HookRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      cwd: tmpDir,
      systemPrompt: "You are a careful fixer.",
    });

    await agent.run("Investigate twice().");
    const beforeCompact = agent.session.messages.length;
    expect(beforeCompact).toBeGreaterThan(4);

    await agent.compactWithSummary(2, async () => {
      return "SUMMARY: twice(n) incorrectly returns n; should return n*2. check.mjs asserts twice(3)===6.";
    });
    await agent.flushSession();

    const afterCompact = agent.session.messages.length;
    expect(afterCompact).toBeLessThan(beforeCompact);
    expect(
      agent.session.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b) =>
              b.type === "text" &&
              b.text.includes("SUMMARY") &&
              b.text.includes("twice"),
          ),
      ),
    ).toBe(true);

    const result = await agent.run("Apply the fix and run the check.");
    expect(result.stopReason).toBe("end_turn");
    expect(
      await fs.readFile(path.join(tmpDir, "pkg", "util.js"), "utf8"),
    ).toContain("n * 2");
    expect(toolTexts(agent).some((r) => r.includes("PASS"))).toBe(true);

    // Post-compact model call still has the summary context.
    const postCompactCall = model.calls[3];
    expect(JSON.stringify(postCompactCall?.messages ?? [])).toMatch(
      /SUMMARY|twice/i,
    );
  });
});
