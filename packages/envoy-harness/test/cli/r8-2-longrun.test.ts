/**
 * R8.2 — long-run REPL defaults + peers wiring hermetic tests.
 */
import { describe, expect, it } from "vitest";

import { runRepl } from "../../src/index.js";
import { wireCliPeers } from "../../src/cli/run/wire-cli-peers.js";
import type { ConfigLayer } from "../../src/config/index.js";
import type { ReplCommand } from "../../src/cli/repl/types.js";
import {
  StringWritable,
  fakeLineReader,
  makeArgs,
  scriptedModel,
  textBlock,
} from "../helpers.js";

describe("R8.2 REPL long-run defaults", () => {
  it("defaults maxIterations to 200 when --max-turns unset", async () => {
    let captured = 0;
    const probe: ReplCommand = {
      name: "/probe-max",
      description: "test probe",
      handler(_args, ctx) {
        captured = ctx.agent.maxIterations;
      },
    };
    await runRepl({
      model: scriptedModel([{ content: [textBlock("x")] }]),
      args: makeArgs({ maxTurns: undefined }),
      customCommands: [probe],
      lineReader: fakeLineReader(["/probe-max", "/quit"]),
      stdout: new StringWritable(),
      stderr: new StringWritable(),
    });
    expect(captured).toBe(200);
  });

  it("honors explicit --max-turns over the REPL default", async () => {
    let captured = 0;
    const probe: ReplCommand = {
      name: "/probe-max",
      description: "test probe",
      handler(_args, ctx) {
        captured = ctx.agent.maxIterations;
      },
    };
    await runRepl({
      model: scriptedModel([{ content: [textBlock("x")] }]),
      args: makeArgs({ maxTurns: 7 }),
      customCommands: [probe],
      lineReader: fakeLineReader(["/probe-max", "/quit"]),
      stdout: new StringWritable(),
      stderr: new StringWritable(),
    });
    expect(captured).toBe(7);
  });

  it("does not apply one-shot $5 cost ceiling by default", async () => {
    let captured: number | undefined;
    const probe: ReplCommand = {
      name: "/probe-cost",
      description: "test probe",
      handler(_args, ctx) {
        captured = ctx.agent.maxCostUsd;
      },
    };
    await runRepl({
      model: scriptedModel([{ content: [textBlock("x")] }]),
      args: makeArgs({ maxCostUsd: undefined }),
      customCommands: [probe],
      lineReader: fakeLineReader(["/probe-cost", "/quit"]),
      stdout: new StringWritable(),
      stderr: new StringWritable(),
    });
    expect(captured).toBeUndefined();
  });

  it("does not auto-persist when lineReader is injected (test path)", async () => {
    const err = new StringWritable();
    const result = await runRepl({
      model: scriptedModel([{ content: [textBlock("x")] }]),
      args: makeArgs({ persist: false, resume: undefined }),
      lineReader: fakeLineReader(["/quit"]),
      stdout: new StringWritable(),
      stderr: err,
    });
    expect(result.sessionId).toBeTruthy();
    expect(err.data).not.toMatch(/auto-persisted|persisted session/);
  });
});

describe("R8.2 wireCliPeers", () => {
  it("is a no-op when no peers are configured", async () => {
    const err = new StringWritable();
    const dispose = await wireCliPeers({
      parsed: makeArgs({ peers: [] }),
      configLayer: {} as ConfigLayer,
      stderr: err,
    });
    await dispose();
    expect(err.data).toBe("");
  });
});
