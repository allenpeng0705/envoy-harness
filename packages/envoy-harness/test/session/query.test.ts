/**
 * Phase D / Item 14a — session query + indexer (hermetic).
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { PersistedSession } from "../../src/session/persisted-session.js";
import {
  createSessionQueryService,
  isPathInside,
  makeSessionQueryTool,
} from "../../src/session/index.js";

async function writeFixture(dir: string, id: string): Promise<string> {
  const filePath = path.join(dir, `${id}.jsonl`);
  const session = await PersistedSession.create({
    id,
    filePath,
    metadata: {
      cwd: dir,
      startedAt: "2026-01-15T12:00:00.000Z",
      title: "fixture",
      permissionMode: "read-only",
    },
  });
  session.appendMessage("user", [{ type: "text", text: "find the payment bug" }]);
  session.appendMessage("assistant", [
    {
      type: "tool_call",
      id: "c1",
      name: "bash",
      args: { command: "grep -r payment ." },
    },
  ]);
  session.appendMessage("tool", [
    {
      type: "tool_result",
      toolCallId: "c1",
      content: "payment.ts:42",
      isError: false,
    },
  ]);
  await session.flush();
  return filePath;
}

describe("session query", () => {
  it("indexes and searches by pattern + toolName", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sq-"));
    await writeFixture(dir, "sess-a");

    const service = createSessionQueryService({ dir });
    const { entryCount } = await service.reindex();
    expect(entryCount).toBeGreaterThanOrEqual(3);

    const byPattern = service.search({ pattern: "payment", limit: 10 });
    expect(byPattern.length).toBeGreaterThan(0);
    expect(byPattern.some((h) => h.snippet.includes("payment"))).toBe(true);

    const byTool = service.search({ toolName: "bash" });
    expect(byTool).toHaveLength(1);
    expect(byTool[0]?.role).toBe("assistant");
  });

  it("rejects paths outside the session dir (auth)", () => {
    const root = "/tmp/sessions-root";
    expect(isPathInside("/tmp/sessions-root/a.jsonl", root)).toBe(true);
    expect(isPathInside("/etc/passwd", root)).toBe(false);
  });

  it("session_query tool returns JSON hits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sq-tool-"));
    await writeFixture(dir, "sess-b");
    const service = createSessionQueryService({ dir });
    await service.reindex();
    const tool = makeSessionQueryTool(service);
    const result = await tool.execute(
      { pattern: "payment", reindex: false },
      {
        cwd: dir,
        session: await PersistedSession.open(path.join(dir, "sess-b.jsonl")),
        abortSignal: AbortSignal.timeout(5_000),
      },
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(String(result.content)) as { hits: unknown[] };
    expect(parsed.hits.length).toBeGreaterThan(0);
  });

  it("filters by role and time bounds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sq-time-"));
    await writeFixture(dir, "sess-c");
    const service = createSessionQueryService({ dir });
    await service.reindex();
    const users = service.search({ role: "user" });
    expect(users.every((h) => h.role === "user")).toBe(true);
    const none = service.search({
      since: "2099-01-01T00:00:00.000Z",
    });
    expect(none).toHaveLength(0);
  });

  it("skips corrupt files without failing the whole index", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sq-bad-"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "bad.jsonl"), "not-json\n", "utf8");
    await writeFixture(dir, "good");
    const service = createSessionQueryService({ dir });
    const result = await service.reindex();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.entryCount).toBeGreaterThan(0);
  });
});
