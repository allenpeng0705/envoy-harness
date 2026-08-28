/**
 * Session cancel disposes background jobs and closes terminals.
 */

import { describe, expect, it } from "vitest";

import { Agent } from "../src/agent.js";
import { createLocalJobRegistry } from "../src/jobs/index.js";
import { InMemorySession, newSessionId } from "../src/session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { makeBashTool } from "../src/tools/builtin/bash.js";
import {
  createFakeTerminalBackend,
  createTerminalSessionService,
} from "../src/terminal/index.js";
import type { ModelAdapter } from "../src/model.js";

const neverModel: ModelAdapter = {
  async complete() {
    await new Promise(() => undefined);
    throw new Error("never");
  },
};

describe("Agent.abort owner cleanup", () => {
  it("disposeOwner removes background bash jobs", async () => {
    const jobs = createLocalJobRegistry();
    const tools = new ToolRegistry();
    tools.register(makeBashTool({ jobs }));
    const session = new InMemorySession(newSessionId(), {
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
      permissionMode: "danger-full-access",
    });
    const agent = new Agent({
      model: neverModel,
      tools,
      session,
      cwd: process.cwd(),
      jobRegistry: jobs,
    });

    const started = await tools.get("bash")!.execute(
      { command: "sleep 30", background: true },
      {
        cwd: process.cwd(),
        session,
        abortSignal: new AbortController().signal,
      },
    );
    JSON.parse(String(started.content)) as { id: string };
    expect(jobs.list(session.id).length).toBe(1);

    agent.abort();
    await new Promise((r) => setTimeout(r, 300));
    expect(jobs.list(session.id)).toHaveLength(0);
    await jobs.dispose();
  });

  it("closes owned terminal sessions", async () => {
    const terminals = createTerminalSessionService();
    terminals.registerBackend(createFakeTerminalBackend());
    const session = new InMemorySession(newSessionId(), {
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    });
    const tools = new ToolRegistry();
    const agent = new Agent({
      model: neverModel,
      tools,
      session,
      cwd: process.cwd(),
      terminalService: terminals,
    });

    await terminals.spawn(session.id, { type: "fake" }, new AbortController().signal);
    expect(terminals.list(session.id).length).toBe(1);

    agent.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(terminals.list(session.id)).toHaveLength(0);
    await terminals.dispose();
  });
});
