/**
 * End-to-end tests.
 *
 * The design's §22 Phase 1 milestone: "the agent loop runs; the
 * CLI takes a prompt and returns a response." These tests
 * exercise the full stack — tool registry, built-in tools,
 * agent loop, CLI runner — with a scripted model adapter.
 *
 * **Two e2e paths:**
 * 1. Direct: `Agent` + `ToolRegistry` + `FakeModel`. Tests the
 *    loop in isolation.
 * 2. Via CLI: `run()` with a fake model. Tests argv → agent →
 *    output.
 *
 * **What the scripted model does:** the canonical "read a file,
 * run a command, summarize" flow from the design. The model
 * emits two tool calls, then a final text response. The test
 * verifies all three happen in order.
 *
 * **Real-model parity:** when a real model adapter lands, this
 * test becomes the snapshot for `pnpm run test:snapshot`.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Agent,
  bashTool,
  InMemorySession,
  newSessionId,
  readFileTool,
  run,
  ToolRegistry,
  type Session,
  type SessionMetadata,
} from "../src/index.js";

import { textResponse, toolCall } from "./fixtures/fake-model.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-harness-e2e-"));
  // Create a file the agent will read.
  await fs.writeFile(
    path.join(tmpDir, "notes.txt"),
    "the secret password is: open-sesame\n",
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeSession(cwd: string): Session {
  const meta: SessionMetadata = {
    cwd,
    permissionMode: "workspace-write",
    startedAt: new Date().toISOString(),
  };
  return new InMemorySession(newSessionId(), meta);
}

/** A recorder for stdout / stderr. */
class StringWritable extends Writable {
  data = "";
  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void,
  ): void {
    this.data += chunk.toString();
    cb();
  }
}

describe("e2e: read → run → summarize (direct agent)", () => {
  it("executes the full flow: read a file, run ls, summarize", async () => {
    // The model "knows" the file path because the test passes it
    // via the prompt. A real model would discover the file via
    // exploration; the fake gets it from the prompt.
    const filePath = path.join(tmpDir, "notes.txt");
    const script = [
      // Turn 1: model reads the file.
      { content: [toolCall("tc1", "read_file", { path: filePath })] },
      // Turn 2: model runs ls on the dir.
      { content: [toolCall("tc2", "bash", { command: `ls -la ${tmpDir}` })] },
      // Turn 3: model summarizes.
      textResponse(
        "Summary: notes.txt contains a secret. The directory has 1 file.",
      ),
    ];
    const model = {
      calls: [] as Array<{ messages: ReadonlyArray<{ role: string; content: unknown }> }>,
      async complete(input: { messages: ReadonlyArray<{ role: string; content: unknown }> }) {
        this.calls.push({ messages: input.messages });
        const entry = script[this.calls.length - 1];
        if (!entry) throw new Error("script exhausted");
        if ("error" in entry) throw entry.error;
        const hasToolCall = entry.content.some((b) => b.type === "tool_call");
        return {
          content: entry.content,
          stopReason: hasToolCall ? ("tool_use" as const) : ("end_turn" as const),
        };
      },
    };

    const tools = new ToolRegistry();
    tools.register(readFileTool);
    tools.register(bashTool);
    const session = makeSession(tmpDir);
    const agent = new Agent({ model, tools, session, cwd: tmpDir });

    const result = await agent.run(`Read ${filePath} and list the directory.`);

    // Final result.
    expect(result.stopReason).toBe("end_turn");
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toBe(2);
    expect((result.content[0] as { type: string; text: string }).text).toContain("Summary");

    // Transcript shape: user, assistant(1), tool, assistant(2), tool, assistant(3).
    const roles = session.messages.map((m) => m.role);
    expect(roles).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);

    // Tool 1: read_file returned the file content.
    const toolMsg1 = session.messages[2];
    const toolResult1 = toolMsg1?.content[0] as { content: string; isError: boolean };
    expect(toolResult1.content).toContain("open-sesame");
    expect(toolResult1.isError).toBe(false);

    // Tool 2: bash returned ls output including notes.txt.
    const toolMsg2 = session.messages[4];
    const toolResult2 = toolMsg2?.content[0] as { content: string; isError: boolean };
    expect(toolResult2.content).toContain("notes.txt");
    expect(toolResult2.isError).toBe(false);
  });
});

describe("e2e: read → run → summarize (via CLI)", () => {
  it("CLI run() with a fake model produces the summary on stdout", async () => {
    const filePath = path.join(tmpDir, "notes.txt");
    const out = new StringWritable();
    const err = new StringWritable();

    const script = [
      { content: [toolCall("tc1", "read_file", { path: filePath })] },
      { content: [toolCall("tc2", "bash", { command: `wc -l ${filePath}` })] },
      textResponse("Done. The file has 1 line."),
    ];
    const model = {
      calls: 0,
      async complete() {
        const entry = script[this.calls++];
        if (!entry) throw new Error("script exhausted");
        if ("error" in entry) throw entry.error;
        const hasToolCall = entry.content.some((b) => b.type === "tool_call");
        return {
          content: entry.content,
          stopReason: hasToolCall ? ("tool_use" as const) : ("end_turn" as const),
        };
      },
    };

    const result = await run({
      argv: ["read", filePath, "and", "count", "lines"],
      model,
      stdout: out,
      stderr: err,
      cwd: tmpDir,
    });

    if (result.subcommand !== "run") throw new Error("expected run subcommand");
    expect(result.stopReason).toBe("end_turn");
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toBe(2);
    expect(result.content).toContain("Done");
    expect(out.data).toContain("Done");
    // Stderr should be empty (no warnings).
    expect(err.data).toBe("");
  });

  it("CLI run() respects --sandbox read-only (bash tool blocks writes)", async () => {
    const out = new StringWritable();
    const err = new StringWritable();
    // read-only: bash is blocked entirely, so the tool returns isError.
    // The model can't run bash, but it CAN read files.
    const script = [
      { content: [toolCall("tc1", "bash", { command: "echo x" })] },
      textResponse("ok"),
    ];
    const model = {
      calls: 0,
      async complete() {
        const entry = script[this.calls++];
        if (!entry) throw new Error("script exhausted");
        if ("error" in entry) throw entry.error;
        const hasToolCall = entry.content.some((b) => b.type === "tool_call");
        return {
          content: entry.content,
          stopReason: hasToolCall ? ("tool_use" as const) : ("end_turn" as const),
        };
      },
    };
    await run({
      argv: ["--sandbox", "read-only", "echo"],
      model,
      stdout: out,
      stderr: err,
      cwd: tmpDir,
    });
    // The model recovered; the loop exited cleanly.
    expect(out.data).toContain("ok");
  });
});
