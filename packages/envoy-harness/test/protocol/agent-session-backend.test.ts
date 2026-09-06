import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  attachAcpServer,
  createAgentSessionBackend,
  createInProcessJsonRpcPair,
  type ProtocolSessionBackend,
} from "../../src/protocol/index.js";
import {
  Agent,
  InMemorySession,
  SessionStore,
  ToolRegistry,
} from "../../src/index.js";
import { HookRegistry } from "../../src/hooks/index.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FakeModel,
  textResponse,
} from "../fixtures/fake-model.js";

describe("createAgentSessionBackend", () => {
  it("cancel calls agent.abort (not only a local AbortController)", async () => {
    let abortCalls = 0;
    const backend = createAgentSessionBackend({
      createAgent: () => {
        const mock = {
          abort() {
            abortCalls += 1;
          },
          async run(_prompt: string) {
            await new Promise<void>((resolve) => {
              // Stay in-flight until cancel aborts via agent.abort().
              const tick = setInterval(() => {
                if (abortCalls > 0) {
                  clearInterval(tick);
                  resolve();
                }
              }, 5);
            });
            return {
              messages: [{ role: "assistant", content: "stopped" }],
              stopReason: "aborted" as const,
              costUsd: 0,
              iterations: 0,
            };
          },
        };
        return mock as unknown as Agent;
      },
    });

    const { sessionId } = await backend.createSession({});
    const ac = new AbortController();
    const promptPromise = backend.prompt({
      sessionId,
      prompt: { text: "slow" },
      signal: ac.signal,
      requestPermission: async () => "allow",
    });
    await new Promise((r) => setTimeout(r, 15));
    backend.cancel(sessionId);
    const result = await promptPromise;
    expect(abortCalls).toBeGreaterThanOrEqual(1);
    expect(result.stopReason).toBe("aborted");
  });
  it("createSession persists to the sessionStore when one is configured", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "acp-persist-"),
    );
    try {
      const store = new SessionStore({ dir });
      let receivedSession: unknown;
      const backend = createAgentSessionBackend({
        defaultCwd: "/proj",
        sessionStore: store,
        createAgent: ({ sessionId, cwd, session }) => {
          receivedSession = session;
          return new Agent({
            model: new FakeModel([textResponse("ok")]),
            tools: new ToolRegistry(),
            hooks: new HookRegistry(),
            session:
              session ??
              new InMemorySession(sessionId, {
                cwd: cwd ?? "/proj",
                permissionMode: "workspace-write",
                startedAt: new Date().toISOString(),
              }),
            cwd: cwd ?? "/proj",
          });
        },
      });

      const { sessionId } = await backend.createSession({ cwd: "/proj" });
      // The session is on disk immediately (multi-session resume needs
      // this), and the Agent was built on the persisted session.
      expect(await store.exists(sessionId)).toBe(true);
      expect(receivedSession).toBeDefined();

      await backend.prompt({
        sessionId,
        prompt: { text: "hi" },
        signal: new AbortController().signal,
        requestPermission: async () => "allow",
      });
      // Wait for the fire-and-forget JSONL flush, then verify the turn
      // wrote through to the persisted transcript.
      await new Promise((r) => setTimeout(r, 25));
      const persisted = await store.load(sessionId);
      expect(persisted.messages.length).toBeGreaterThan(0);

      // loadSession can resume it under the same id.
      const loaded = await backend.loadSession!({ sessionId });
      expect(loaded.sessionId).toBe(sessionId);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("setPolicy autoRun 'off' auto-approves tools without invoking the ask handler", async () => {
    let askCalls = 0;
    const backend = createAgentSessionBackend({
      defaultCwd: "/proj",
      createAgent: ({ sessionId, cwd, session, askHandler }) =>
        new Agent({
          model: new FakeModel([
            {
              content: [
                {
                  type: "tool_call",
                  id: "t1",
                  name: "bash",
                  args: { command: "rm -rf /tmp/x" },
                },
              ],
            },
            textResponse("done"),
          ]),
          tools: (() => {
            const registry = new ToolRegistry();
            registry.register({
              name: "bash",
              description: "shell",
              parameters: z.object({ command: z.string() }),
              async execute({ command }) {
                return { content: `ran: ${command}` };
              },
            });
            return registry;
          })(),
          hooks: new HookRegistry(),
          session:
            session ??
            new InMemorySession(sessionId, {
              cwd: cwd ?? "/proj",
              permissionMode: "workspace-write",
              startedAt: new Date().toISOString(),
            }),
          cwd: cwd ?? "/proj",
          ...(askHandler !== undefined ? { askHandler } : {}),
        }),
    });
    const { sessionId } = await backend.createSession({});
    // Set the auto-run policy to "always approve".
    await backend.setPolicy!({ sessionId, autoRun: "off" });
    await backend.prompt({
      sessionId,
      prompt: { text: "clean tmp" },
      signal: new AbortController().signal,
      requestPermission: async () => {
        askCalls += 1;
        return "deny";
      },
    });
    // Even a destructive bash call ran WITHOUT asking (autoRun off).
    expect(askCalls).toBe(0);
  });
  it("setPolicy autoRun 'always-confirm' still asks (host prompt fires)", async () => {
    let askCalls = 0;
    const backend = createAgentSessionBackend({
      defaultCwd: "/proj",
      createAgent: ({ sessionId, cwd, session, askHandler }) =>
        new Agent({
          model: new FakeModel([
            {
              content: [
                {
                  type: "tool_call",
                  id: "t1",
                  name: "bash",
                  args: { command: "ls" },
                },
              ],
            },
            textResponse("done"),
          ]),
          tools: (() => {
            const registry = new ToolRegistry();
            registry.register({
              name: "bash",
              description: "shell",
              parameters: z.object({ command: z.string() }),
              async execute({ command }) {
                return { content: `ran: ${command}` };
              },
            });
            return registry;
          })(),
          hooks: new HookRegistry(),
          session:
            session ??
            new InMemorySession(sessionId, {
              cwd: cwd ?? "/proj",
              permissionMode: "workspace-write",
              startedAt: new Date().toISOString(),
            }),
          cwd: cwd ?? "/proj",
          ...(askHandler !== undefined ? { askHandler } : {}),
        }),
    });
    const { sessionId } = await backend.createSession({});
    await backend.setPolicy!({ sessionId, autoRun: "always-confirm" });
    await backend.prompt({
      sessionId,
      prompt: { text: "list" },
      signal: new AbortController().signal,
      requestPermission: async () => {
        askCalls += 1;
        return "deny";
      },
    });
    expect(askCalls).toBeGreaterThan(0);
  });
  it("prompt returns only this-turn messages (not full history)", async () => {
    let turn = 0;
    const backend = createAgentSessionBackend({
      createAgent: () => {
        const history: Array<{ role: string; content: string }> = [];
        const mock = {
          abort() {},
          getMessageCount() {
            return history.length;
          },
          async run(prompt: string | ReadonlyArray<{ type: string }>) {
            turn += 1;
            const text =
              typeof prompt === "string"
                ? prompt
                : prompt
                    .map((b) =>
                      b.type === "text" && "text" in b
                        ? String((b as { text: string }).text)
                        : "[block]",
                    )
                    .join("\n");
            history.push({ role: "user", content: text });
            history.push({
              role: "assistant",
              content: `reply-${turn}`,
            });
            return {
              messages: [...history],
              stopReason: "end_turn" as const,
              costUsd: 0,
              iterations: 1,
            };
          },
        };
        return mock as unknown as Agent;
      },
    });

    const { sessionId } = await backend.createSession({});
    const r1 = await backend.prompt({
      sessionId,
      prompt: { text: "first" },
      signal: new AbortController().signal,
      requestPermission: async () => "allow",
    });
    expect(r1.messages.map((m) => m.text)).toEqual(["first", "reply-1"]);

    const r2 = await backend.prompt({
      sessionId,
      prompt: { text: "second" },
      signal: new AbortController().signal,
      requestPermission: async () => "allow",
    });
    expect(r2.messages.map((m) => m.text)).toEqual(["second", "reply-2"]);
  });

  it("cancel unblocks an in-flight requestPermission wait", async () => {
    let abortCalls = 0;
    let permissionStarted = false;
    const backend = createAgentSessionBackend({
      createAgent: ({ askHandler }) => {
        const mock = {
          abort() {
            abortCalls += 1;
          },
          getMessageCount() {
            return 0;
          },
          async run(_prompt: string) {
            permissionStarted = true;
            const decision = await askHandler({
              tool: "bash",
              args: { command: "echo hi" },
              question: "Allow bash?",
              signal: new AbortController().signal,
            });
            return {
              messages: [
                {
                  role: "assistant",
                  content: decision.kind === "deny" ? "denied" : "ok",
                },
              ],
              stopReason: "end_turn" as const,
              costUsd: 0,
              iterations: 1,
            };
          },
        };
        return mock as unknown as Agent;
      },
    });

    const { sessionId } = await backend.createSession({});
    const promptPromise = backend.prompt({
      sessionId,
      prompt: { text: "need-perm" },
      signal: new AbortController().signal,
      requestPermission: () =>
        new Promise(() => {
          /* never resolves — cancel must unblock */
        }),
    });
    for (let i = 0; i < 50 && !permissionStarted; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(permissionStarted).toBe(true);
    backend.cancel(sessionId);
    const result = await promptPromise;
    expect(abortCalls).toBeGreaterThanOrEqual(1);
    expect(result.messages.some((m) => m.text === "denied")).toBe(true);
  });

  it("requestUserQuestion parks ask_user until the host answers", async () => {
    const backend = createAgentSessionBackend({
      createAgent: ({ userQuestions }) => {
        const mock = {
          abort() {},
          getMessageCount() {
            return 0;
          },
          async run(_prompt: string) {
            const answer = await userQuestions.ask({
              prompt: "Which file?",
              options: ["a.ts", "b.ts"],
              signal: new AbortController().signal,
            });
            return {
              messages: [
                {
                  role: "assistant",
                  content: answer.cancelled
                    ? "cancelled"
                    : `chose:${answer.value}`,
                },
              ],
              stopReason: "end_turn" as const,
              costUsd: 0,
              iterations: 1,
            };
          },
        };
        return mock as unknown as Agent;
      },
    });

    const { sessionId } = await backend.createSession({});
    let resolveHost!: (a: {
      value: string;
      optionIndex?: number;
    }) => void;
    const hostGate = new Promise<{
      value: string;
      optionIndex?: number;
    }>((r) => {
      resolveHost = r;
    });
    const promptPromise = backend.prompt({
      sessionId,
      prompt: { text: "ask" },
      signal: new AbortController().signal,
      requestPermission: async () => "allow",
      requestUserQuestion: async (req) => {
        expect(req.prompt).toBe("Which file?");
        expect(req.options).toEqual(["a.ts", "b.ts"]);
        return await hostGate;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    resolveHost({ value: "b.ts", optionIndex: 1 });
    const result = await promptPromise;
    expect(result.messages.some((m) => m.text === "chose:b.ts")).toBe(true);
  });

  it("cancel unblocks an in-flight requestUserQuestion wait", async () => {
    let questionStarted = false;
    const backend = createAgentSessionBackend({
      createAgent: ({ userQuestions }) => {
        const mock = {
          abort() {},
          getMessageCount() {
            return 0;
          },
          async run(_prompt: string) {
            questionStarted = true;
            const answer = await userQuestions.ask({
              prompt: "stuck?",
              signal: new AbortController().signal,
            });
            return {
              messages: [
                {
                  role: "assistant",
                  content: answer.cancelled ? "cancelled" : "answered",
                },
              ],
              stopReason: "end_turn" as const,
              costUsd: 0,
              iterations: 1,
            };
          },
        };
        return mock as unknown as Agent;
      },
    });

    const { sessionId } = await backend.createSession({});
    const promptPromise = backend.prompt({
      sessionId,
      prompt: { text: "need-answer" },
      signal: new AbortController().signal,
      requestPermission: async () => "allow",
      requestUserQuestion: () =>
        new Promise(() => {
          /* never resolves — cancel must unblock */
        }),
    });
    for (let i = 0; i < 50 && !questionStarted; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(questionStarted).toBe(true);
    backend.cancel(sessionId);
    const result = await promptPromise;
    expect(result.messages.some((m) => m.text === "cancelled")).toBe(true);
  });

  it("evicts oldest sessions when maxSessions is exceeded", async () => {
    const backend = createAgentSessionBackend({
      maxSessions: 2,
      createAgent: () =>
        ({
          abort() {},
          getMessageCount: () => 0,
          async run(prompt: string) {
            return {
              messages: [{ role: "assistant", content: prompt }],
              stopReason: "end_turn" as const,
              costUsd: 0,
              iterations: 0,
            };
          },
        }) as unknown as Agent,
    });
    const a = await backend.createSession({});
    const b = await backend.createSession({});
    const c = await backend.createSession({});
    await expect(
      backend.prompt({
        sessionId: a.sessionId,
        prompt: { text: "gone" },
        signal: new AbortController().signal,
        requestPermission: async () => "allow",
      }),
    ).rejects.toThrow(/unknown session/);
    const ok = await backend.prompt({
      sessionId: c.sessionId,
      prompt: { text: "kept" },
      signal: new AbortController().signal,
      requestPermission: async () => "allow",
    });
    expect(ok.messages[0]?.text).toBe("kept");
    void b;
  });

  it("compact drops messages via session/compact", async () => {
    const messages: Array<{ role: string; content: string }> = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const backend = createAgentSessionBackend({
      createAgent: () =>
        ({
          abort() {},
          cwd: process.cwd(),
          getMessageCount() {
            return messages.length;
          },
          compact(keep: number) {
            const next = messages.slice(-keep);
            messages.length = 0;
            messages.push(...next);
          },
          async run(prompt: string) {
            messages.push({ role: "user", content: prompt });
            messages.push({ role: "assistant", content: "ok" });
            return {
              messages: [...messages],
              stopReason: "end_turn" as const,
              costUsd: 0,
              iterations: 1,
            };
          },
        }) as unknown as Agent,
    });
    const { sessionId } = await backend.createSession({});
    const result = await backend.compact!({ sessionId, keep: 2 });
    expect(result.messageCountBefore).toBe(4);
    expect(result.messageCountAfter).toBe(2);
    expect(result.droppedCount).toBe(2);
  });

  it("emits session/token while the model streams", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = createAgentSessionBackend({
      createAgent: ({ sessionId, cwd, askHandler }) =>
        new Agent({
          model: new FakeModel([textResponse("streamed hello")]),
          tools: new ToolRegistry(),
          hooks: new HookRegistry(),
          session: new InMemorySession(sessionId, {
            cwd: cwd ?? process.cwd(),
            startedAt: new Date().toISOString(),
            permissionMode: "workspace-write",
          }),
          cwd: cwd ?? process.cwd(),
          askHandler,
        }),
    });
    attachAcpServer({ connection: pair.server, backend });

    await pair.client.request("initialize", {});
    const { sessionId } = (await pair.client.request("session/new", {})) as {
      sessionId: string;
    };

    const tokens: string[] = [];
    pair.client.setNotificationHandler((method, params) => {
      if (method === "session/token") {
        const p = params as { token?: { delta?: string } };
        if (p.token?.delta !== undefined) tokens.push(p.token.delta);
      }
    });

    const result = (await pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "hi" },
    })) as { stopReason: string; messages: Array<{ text: string }> };

    expect(result.stopReason).toBe("end_turn");
    expect(tokens.join("")).toBe("streamed hello");
    expect(result.messages.some((m) => m.text === "streamed hello")).toBe(true);
    pair.close();
  });

  it("clears stream sinks when cancelled mid-prompt", async () => {
    let agentRef: Agent | undefined;
    const backend = createAgentSessionBackend({
      createAgent: ({ sessionId, cwd, askHandler }) => {
        const agent = new Agent({
          model: new FakeModel([textResponse("done")]),
          tools: new ToolRegistry(),
          hooks: new HookRegistry(),
          session: new InMemorySession(sessionId, {
            cwd: cwd ?? process.cwd(),
            startedAt: new Date().toISOString(),
            permissionMode: "workspace-write",
          }),
          cwd: cwd ?? process.cwd(),
          askHandler,
        });
        agentRef = agent;
        return agent;
      },
    });

    const { sessionId } = await backend.createSession({});
    const ac = new AbortController();
    const tokens: string[] = [];
    const promptPromise = backend.prompt({
      sessionId,
      prompt: { text: "hi" },
      signal: ac.signal,
      requestPermission: async () => "allow",
      onToken: (t) => tokens.push(t.delta),
    });
    await new Promise((r) => setTimeout(r, 5));
    const staleSink = agentRef!.assistantStreamSink;
    backend.cancel(sessionId);
    await promptPromise;
    expect(agentRef?.assistantStreamSink).toBeUndefined();
    expect(agentRef?.toolOutputSink).toBeUndefined();
    const countAfterCancel = tokens.length;
    staleSink?.("stale");
    expect(tokens.length).toBe(countAfterCancel);
  });

  it("session/cancel stops mid-prompt token notifications", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend: ProtocolSessionBackend = {
      async createSession() {
        return { sessionId: "sess-cancel-stream" };
      },
      async prompt(params) {
        const local = new AbortController();
        params.signal.addEventListener("abort", () => local.abort(), {
          once: true,
        });
        let count = 0;
        while (!local.signal.aborted && count < 200) {
          params.onToken?.({ role: "assistant", delta: "x" });
          count += 1;
          await new Promise((r) => setTimeout(r, 5));
        }
        return {
          stopReason: local.signal.aborted ? "cancelled" : "end_turn",
          messages: [],
        };
      },
      cancel() {},
    };
    attachAcpServer({ connection: pair.server, backend });

    await pair.client.request("initialize", {});
    const { sessionId } = (await pair.client.request("session/new", {})) as {
      sessionId: string;
    };

    const tokens: string[] = [];
    pair.client.setNotificationHandler((method, params) => {
      if (method === "session/token") {
        const p = params as { token?: { delta?: string } };
        if (p.token?.delta !== undefined) tokens.push(p.token.delta);
      }
    });

    const promptPromise = pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "slow" },
    });
    await new Promise((r) => setTimeout(r, 25));
    await pair.client.request("session/cancel", { sessionId });
    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe("cancelled");
    expect(tokens.length).toBeLessThan(200);
    expect(tokens.length).toBeGreaterThan(0);
    pair.close();
  });
});
