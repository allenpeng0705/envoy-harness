/**
 * F14.1 — Tier 2 batch 3 command tests (/rename, /copy).
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  BUILTIN_TIER2_BATCH3_COMMANDS,
  HookRegistry,
  InMemorySession,
  newSessionId,
  runRepl,
  ToolRegistry,
  type ReplOptions,
} from "../src/index.js";
import {
  StringWritable,
  fakeLineReader,
  makeArgs,
  scriptedModel,
  textBlock,
} from "./helpers.js";

describe("BUILTIN_TIER2_BATCH3_COMMANDS", () => {
  it("has the 2 expected commands", () => {
    expect(BUILTIN_TIER2_BATCH3_COMMANDS.map((c) => c.name).sort()).toEqual([
      "/copy",
      "/rename",
    ]);
  });

  it("/rename sets the session title via the Agent", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/rename my project", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("my project");
  });

  it("/copy prints the last assistant response", async () => {
    const model = scriptedModel([{ content: [textBlock("hello from model")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["say hi", "/copy", "/quit"]),
      stdout: out,
      stderr: err,
      historyPath: "",
    });
    expect(out.data).toContain("hello from model");
  });

  it("/copy reports when no turn has run", async () => {
    const model = scriptedModel([{ content: [textBlock("ok")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["/copy", "/quit"]),
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
      model: scriptedModel([{ content: [textBlock("ok")] }]),
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
    });
    agent.setTitle("fixed title");
    expect(session.metadata.title).toBe("fixed title");
  });
});

export type { ReplOptions };
