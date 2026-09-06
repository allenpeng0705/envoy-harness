/**
 * Parity steps — undo journal + doctor.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { ActionJournal } from "../src/action-journal.js";
import { policyFromMode } from "../src/permissions/policy.js";
import {
  runDoctorChecks,
  windowsSandboxDoctorCheck,
} from "../src/cli/run/doctor.js";
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

  it("reports windows_sandbox skipped off win32", async () => {
    if (process.platform === "win32") return;
    const checks = await runDoctorChecks({
      subcommand: "doctor",
      help: false,
      version: false,
    });
    expect(checks.find((c) => c.name === "windows_sandbox")).toEqual({
      name: "windows_sandbox",
      ok: true,
      detail: "skipped (not win32)",
    });
  });
});

describe("windowsSandboxDoctorCheck", () => {
  it("labels F2b when the sidecar is available", () => {
    expect(
      windowsSandboxDoctorCheck({
        probeOk: true,
        sidecarAvailable: true,
        stderr: "",
        exitCode: 0,
      }),
    ).toEqual({
      name: "windows_sandbox",
      ok: true,
      detail: "F2b sidecar probe ok (echo)",
    });
  });

  it("labels F2a when the sidecar is not built", () => {
    expect(
      windowsSandboxDoctorCheck({
        probeOk: true,
        sidecarAvailable: false,
        stderr: "",
        exitCode: 0,
      }),
    ).toEqual({
      name: "windows_sandbox",
      ok: true,
      detail: "F2a job-object probe ok (echo)",
    });
  });

  it("surfaces stderr on probe failure", () => {
    expect(
      windowsSandboxDoctorCheck({
        probeOk: false,
        sidecarAvailable: false,
        stderr: "boom\n",
        exitCode: 1,
      }),
    ).toEqual({
      name: "windows_sandbox",
      ok: false,
      detail: "boom",
    });
  });
});
