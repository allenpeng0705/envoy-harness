/**
 * F14.1 — Tier 2 batch 3 command tests (/rename, /copy).
 */

import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";

import {
  Agent,
  BUILTIN_TIER2_BATCH3_COMMANDS,
  HookRegistry,
  InMemorySession,
  newSessionId,
  runRepl,
  ToolRegistry,
  type LineReader,
  type ModelAdapter,
  type ReplOptions,
} from "../src/index.js";

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

function scriptedModel(
  responses: ReadonlyArray<{
    content: string;
    stopReason?: "end_turn";
  }>,
): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const r = responses[i] ?? responses[responses.length - 1]!;
      i++;
      return {
        content: [{ type: "text", text: r.content }],
        stopReason: r.stopReason ?? "end_turn",
      };
    },
  };
}

function lineReader(lines: string[]): LineReader {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (i >= lines.length) return { value: "", done: true };
      return { value: lines[i++]!, done: false };
    },
    close() {},
  };
}

function makeArgs() {
  return {
    subcommand: "run" as const,
    help: false,
    version: false,
    json: false,
    sandbox: undefined,
    approval: undefined,
    model: undefined,
    provider: undefined,
    cwd: undefined,
    maxTurns: undefined,
    maxCostUsd: undefined,
    resume: undefined,
    fork: undefined,
    persist: false,
    sessionDir: undefined,
    plan: false,
    repl: true,
    noColor: false,
    verbose: false,
    quiet: false,
    positional: [],
  };
}

describe("BUILTIN_TIER2_BATCH3_COMMANDS", () => {
  it("has the 2 expected commands", () => {
    expect(BUILTIN_TIER2_BATCH3_COMMANDS.map((c) => c.name).sort()).toEqual([
      "/copy",
      "/rename",
    ]);
  });

  it("/rename sets the session title via the Agent", async () => {
    const model = scriptedModel([{ content: "ok" }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["/rename my project", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("my project");
  });

  it("/copy prints the last assistant response", async () => {
    const model = scriptedModel([{ content: "hello from model" }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["say hi", "/copy", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("hello from model");
  });

  it("/copy reports when no turn has run", async () => {
    const model = scriptedModel([{ content: "ok" }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: lineReader(["/copy", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(err.data).toMatch(/no response yet/);
  });

  it("Agent.setTitle persists through the session", async () => {
    const session = new InMemorySession(newSessionId(), {
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: scriptedModel([{ content: "ok" }]),
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
    });
    agent.setTitle("fixed title");
    expect(session.metadata.title).toBe("fixed title");
  });
});

export type { ReplOptions };
