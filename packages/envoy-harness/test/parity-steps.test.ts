/**
 * Parity steps — undo journal + doctor.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { ActionJournal } from "../src/action-journal.js";
import { policyFromMode } from "../src/permissions/policy.js";
import { runDoctorChecks } from "../src/cli/run/doctor.js";
import { writeTool } from "../src/tools/builtin/write.js";
import { InMemorySession, newSessionId } from "../src/session.js";

describe("ActionJournal", () => {
  it("restores a previous file version", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "undo-"));
    const file = path.join(dir, "a.txt");
    await writeFile(file, "original", "utf8");
    const journal = new ActionJournal();
    journal.push({ path: file, previousContent: "original" });
    await writeFile(file, "changed", "utf8");
    const result = await journal.undoLast();
    expect(result).toEqual({ path: file, action: "restored" });
    expect(await readFile(file, "utf8")).toBe("original");
  });

  it("write tool journals changes for undo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "write-undo-"));
    const file = path.join(dir, "b.txt");
    await writeFile(file, "original", "utf8");
    const journal = new ActionJournal();
    const session = new InMemorySession(newSessionId(), {
      cwd: dir,
      startedAt: new Date().toISOString(),
      permissionMode: "danger-full-access",
    });
    await writeTool.execute(
      { path: "b.txt", content: "changed" },
      {
        cwd: dir,
        session,
        abortSignal: new AbortController().signal,
        sandboxPolicy: policyFromMode("danger-full-access", dir),
        recordUndo: (e) => journal.push(e),
      },
    );
    expect(await readFile(file, "utf8")).toBe("changed");
    await journal.undoLast();
    expect(await readFile(file, "utf8")).toBe("original");
  });
});

describe("runDoctorChecks", () => {
  it("returns basic health checks", async () => {
    const checks = await runDoctorChecks({
      subcommand: "doctor",
      help: false,
      version: false,
    });
    expect(checks.some((c) => c.name === "node" && c.ok)).toBe(true);
    expect(checks.some((c) => c.name === "pty")).toBe(true);
  });
});
