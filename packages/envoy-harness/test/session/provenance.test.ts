/**
 * Phase D / Item 14b — provenance + checkpoint round-trip.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { PersistedSession } from "../../src/session/persisted-session.js";
import { parseArgs } from "../../src/cli/argv.js";
import { resolveSession } from "../../src/session/resolve.js";
import { SessionStore } from "../../src/session/session-store.js";
import { CliError } from "../../src/cli/run/errors.js";

describe("session provenance", () => {
  it("checkpoint stamps provenance and survives reopen", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prov-"));
    const filePath = path.join(dir, "s1.jsonl");
    const session = await PersistedSession.create({
      id: "s1",
      filePath,
      metadata: {
        cwd: dir,
        startedAt: new Date().toISOString(),
        title: "prov",
      },
    });
    session.appendMessage("user", [{ type: "text", text: "hi" }]);
    await session.checkpoint({
      originNode: "node-a",
      resumedFrom: "prior",
    });

    const reopened = await PersistedSession.open(filePath);
    expect(reopened.metadata.provenance?.originNode).toBe("node-a");
    expect(reopened.metadata.provenance?.resumedFrom).toBe("prior");
    expect(reopened.metadata.provenance?.checkpointAt).toBeTruthy();
  });

  it("--resume stamps resumedFrom via resolveSession", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prov-resume-"));
    const store = new SessionStore({ dir });
    const created = await store.create({
      cwd: dir,
      startedAt: new Date().toISOString(),
      title: "r",
    });
    created.appendMessage("user", [{ type: "text", text: "x" }]);
    await created.flush();

    const parsed = parseArgs(["--resume", created.id, "--session-dir", dir, "ping"]);
    if (parsed.subcommand !== "run") throw new Error("expected run");
    const stderr: string[] = [];
    const session = await resolveSession(
      parsed,
      {
        cwd: dir,
        startedAt: new Date().toISOString(),
      },
      dir,
      { write: (s: string) => { stderr.push(s); return true; } } as unknown as NodeJS.WritableStream,
    );
    expect(session.metadata.provenance?.resumedFrom).toBe(created.id);
    expect(session.metadata.provenance?.checkpointAt).toBeTruthy();
  });

  it("--resume-remote errors with mesh adapter message", () => {
    const parsed = parseArgs(["--resume-remote", "peer-1/sess-9", "hi"]);
    expect(parsed.subcommand).toBe("run");
    if (parsed.subcommand !== "run") return;
    expect(parsed.resumeRemote).toBe("peer-1/sess-9");
  });

  it("resolveSession rejects --resume-remote", async () => {
    const parsed = parseArgs(["--resume-remote", "n1/s1", "hi"]);
    if (parsed.subcommand !== "run") throw new Error("expected run");
    await expect(
      resolveSession(
        parsed,
        { cwd: "/tmp", startedAt: new Date().toISOString() },
        "/tmp",
        { write: () => true } as unknown as NodeJS.WritableStream,
      ),
    ).rejects.toBeInstanceOf(CliError);
    await expect(
      resolveSession(
        parsed,
        { cwd: "/tmp", startedAt: new Date().toISOString() },
        "/tmp",
        { write: () => true } as unknown as NodeJS.WritableStream,
      ),
    ).rejects.toThrow(/mesh adapter/);
  });
});
