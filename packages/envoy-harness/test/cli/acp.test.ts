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
