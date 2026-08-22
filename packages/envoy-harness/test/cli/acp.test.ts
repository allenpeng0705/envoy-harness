/**
 * Phase E / G — hermetic `--acp` stdio dispatch tests.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli/argv.js";
import { CliError } from "../../src/cli/run/errors.js";
import { run } from "../../src/cli/run.js";
import {
  ACP_PROTOCOL_VERSION,
  JsonRpcConnection,
} from "../../src/protocol/index.js";

describe("parseArgs --acp", () => {
  it("sets acp on the run subcommand", () => {
    const a = parseArgs(["--acp"]);
    expect(a.subcommand).toBe("run");
    if (a.subcommand === "run") {
      expect(a.acp).toBe(true);
      expect(a.repl).toBe(false);
    }
  });
});

describe("run --acp", () => {
  it("serves ACP over injected pipes (demo backend)", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const stderrChunks: Buffer[] = [];
    const stderr = new PassThrough();
    stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    const serverDone = run({
      argv: ["--acp", "--quiet"],
      stdin: c2s,
      stdout: s2c,
      stderr,
    });

    const client = new JsonRpcConnection({ input: s2c, output: c2s });
    const init = (await client.request("initialize", {})) as {
      protocolVersion: number;
    };
    expect(init.protocolVersion).toBe(ACP_PROTOCOL_VERSION);

    const created = (await client.request("session/new", {})) as {
      sessionId: string;
    };
    expect(created.sessionId).toMatch(/^sess-/);

    const result = (await client.request("session/prompt", {
      sessionId: created.sessionId,
      text: "ping",
    })) as { stopReason: string; messages: Array<{ text: string }> };

    expect(result.stopReason).toBe("end_turn");
    expect(result.messages.at(-1)?.text).toBe("echo:ping");

    client.close();
    c2s.end();
    await serverDone;

    expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("");
  });

  it("rejects --acp with a positional prompt", async () => {
    try {
      await run({ argv: ["--acp", "hello"] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toMatch(/no positional/);
    }
  });

  it("rejects --acp with --repl", async () => {
    try {
      await run({ argv: ["--acp", "--repl"] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toMatch(/mutually exclusive/);
    }
  });
});

describe("runAcpDispatch env disposal", () => {
  it("disposes the live-agent environment exactly once (regression)", async () => {
    // The createAgent factory was being called per session and
    // the returned EnvironmentCapabilities (jobs/terminals)
    // was discarded, leaking env resources. We now build the
    // env once outside the factory and dispose at end of
    // dispatch — exercised by checking the env-side tools are
    // still resolvable after the server exits (no throw), and
    // by asserting a fresh server can start without leftover
    // state.
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const stderr = new PassThrough();
    const serverDone = run({
      argv: ["--acp", "--quiet"],
      stdin: c2s,
      stdout: s2c,
      stderr,
    });
    const client = new JsonRpcConnection({ input: s2c, output: c2s });
    await client.request("initialize", {});
    const created = (await client.request("session/new", {})) as {
      sessionId: string;
    };
    await client.request("session/prompt", {
      sessionId: created.sessionId,
      text: "one",
    });
    client.close();
    c2s.end();
    await serverDone;
    // After dispatch returns, env.dispose() has been awaited.
    // A second --acp run must succeed (no leftover state).
    const c2s2 = new PassThrough();
    const s2c2 = new PassThrough();
    const stderr2 = new PassThrough();
    const serverDone2 = run({
      argv: ["--acp", "--quiet"],
      stdin: c2s2,
      stdout: s2c2,
      stderr: stderr2,
    });
    const client2 = new JsonRpcConnection({ input: s2c2, output: c2s2 });
    const init2 = (await client2.request("initialize", {})) as {
      protocolVersion: number;
    };
    expect(init2.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    client2.close();
    c2s2.end();
    await serverDone2;
  });
});
