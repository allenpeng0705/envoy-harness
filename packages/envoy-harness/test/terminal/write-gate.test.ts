/**
 * SECURITY — the terminal mutation gate.
 *
 * `bash` has always consulted the session sandbox policy, but the six
 * `terminal_*` tools did not: under `--sandbox read-only`, a
 * `terminal_send` would write into a live PTY, and a session downgraded
 * mid-run kept accepting input. These tests pin the gate shut.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_TERMINAL_INPUT_BYTES,
  createFakeTerminalBackend,
  createTerminalSessionService,
  makeTerminalTools,
  terminalWriteRefusal,
  type SandboxPolicy,
  type Tool,
  type ToolContext,
} from "../../src/index.js";

function policy(mode: SandboxPolicy["mode"]): SandboxPolicy {
  return {
    mode,
    approval: "on-request",
    backend: "none",
    writableRoots: [],
    networkAccess: false,
    slashTmpWritable: false,
  };
}

function makeContext(
  mode: SandboxPolicy["mode"] | undefined,
  sessionId = "sess-a",
): ToolContext {
  return {
    cwd: "/workspace",
    session: { id: sessionId } as ToolContext["session"],
    abortSignal: new AbortController().signal,
    ...(mode !== undefined ? { sandboxPolicy: policy(mode) } : {}),
  };
}

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

function setup(): { tools: Tool[]; service: ReturnType<typeof createTerminalSessionService> } {
  const service = createTerminalSessionService();
  service.registerBackend(createFakeTerminalBackend({ pid: 11 }));
  return { tools: makeTerminalTools(service), service };
}

describe("terminalWriteRefusal (pure)", () => {
  it("refuses every mutation in read-only mode", () => {
    for (const tool of ["terminal_send", "terminal_signal"]) {
      const refusal = terminalWriteRefusal(
        { sandboxPolicy: policy("read-only") },
        tool,
      );
      expect(refusal).toContain("read-only");
      expect(refusal).toContain(tool);
      expect(refusal).toContain("--sandbox workspace-write");
    }
  });

  it("allows mutation in workspace-write and danger-full-access", () => {
    for (const mode of ["workspace-write", "danger-full-access"] as const) {
      expect(
        terminalWriteRefusal({ sandboxPolicy: policy(mode) }, "terminal_send", 10),
      ).toBeUndefined();
    }
  });

  it("fails CLOSED when no policy is present", () => {
    // An absent policy must never mean "allow": the executor always
    // supplies one, so a missing policy is a wiring bug, not consent.
    expect(
      terminalWriteRefusal({}, "terminal_send")?.includes("read-only"),
    ).toBe(true);
  });

  it("rejects oversized input instead of truncating it", () => {
    const refusal = terminalWriteRefusal(
      { sandboxPolicy: policy("workspace-write") },
      "terminal_send",
      MAX_TERMINAL_INPUT_BYTES + 1,
    );
    expect(refusal).toContain("refused");
    expect(refusal).toContain("8000");
    // Exactly at the limit is fine.
    expect(
      terminalWriteRefusal(
        { sandboxPolicy: policy("workspace-write") },
        "terminal_send",
        MAX_TERMINAL_INPUT_BYTES,
      ),
    ).toBeUndefined();
  });
});

describe("terminal_send under a read-only session", () => {
  it("refuses the write and never touches the PTY", async () => {
    const { tools, service } = setup();
    const ctx = makeContext("read-only");

    const opened = await byName(tools, "terminal_open").execute({}, ctx);
    const sessionId = (JSON.parse(String(opened.content)) as { sessionId: string })
      .sessionId;

    const sent = await byName(tools, "terminal_send").execute(
      { sessionId, text: "rm -rf /" },
      ctx,
    );

    expect(sent.isError).toBe(true);
    expect(String(sent.content)).toContain("read-only");

    // Reading is still allowed — the gate is on mutation only.
    const read = await byName(tools, "terminal_read").execute(
      { sessionId },
      ctx,
    );
    expect(read.isError).toBeUndefined();

    // The fake backend never received the text.
    const viewport = service.read(ctx.session.id, sessionId);
    expect(viewport.text).not.toContain("rm -rf");
  });

  it("refuses after a mid-session downgrade", async () => {
    const { tools } = setup();
    const writable = makeContext("workspace-write");
    const opened = await byName(tools, "terminal_open").execute({}, writable);
    const sessionId = (JSON.parse(String(opened.content)) as { sessionId: string })
      .sessionId;

    const ok = await byName(tools, "terminal_send").execute(
      { sessionId, text: "echo hi" },
      writable,
    );
    expect(ok.isError).toBeUndefined();

    // Same session, now read-only.
    const downgraded = { ...writable, sandboxPolicy: policy("read-only") };
    const denied = await byName(tools, "terminal_send").execute(
      { sessionId, text: "echo still-running" },
      downgraded,
    );
    expect(denied.isError).toBe(true);
    expect(String(denied.content)).toContain("read-only");
  });

  it("rejects an oversized write rather than sending a prefix", async () => {
    const { tools, service } = setup();
    const ctx = makeContext("workspace-write");
    const opened = await byName(tools, "terminal_open").execute({}, ctx);
    const sessionId = (JSON.parse(String(opened.content)) as { sessionId: string })
      .sessionId;

    const huge = "x".repeat(MAX_TERMINAL_INPUT_BYTES + 1);
    const result = await byName(tools, "terminal_send").execute(
      { sessionId, text: huge },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("exceeds");
    const viewport = service.read(ctx.session.id, sessionId);
    expect(viewport.text).not.toContain("xxxx");
  });
});

describe("terminal_signal under a read-only session", () => {
  it("refuses to signal a live process group", async () => {
    const { tools } = setup();
    const writable = makeContext("workspace-write");
    const opened = await byName(tools, "terminal_open").execute({}, writable);
    const sessionId = (JSON.parse(String(opened.content)) as { sessionId: string })
      .sessionId;

    const denied = await byName(tools, "terminal_signal").execute(
      { sessionId, signal: "SIGINT" },
      { ...writable, sandboxPolicy: policy("read-only") },
    );
    expect(denied.isError).toBe(true);
    expect(String(denied.content)).toContain("read-only");
  });
});
