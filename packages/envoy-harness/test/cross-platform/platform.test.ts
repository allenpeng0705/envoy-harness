/**
 * Cross-platform smoke tests (path + git helpers). Runs on Linux, macOS, and Windows CI.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatGitOutput,
  runGitStatus,
} from "../../src/protocol/git-runner.js";
import { bashTool } from "../../src/tools/builtin/bash.js";
import { InMemorySession, newSessionId } from "../../src/session.js";

describe("cross-platform helpers", () => {
  it("runGitStatus outside a repo surfaces a readable message", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eh-xplat-"));
    const result = runGitStatus(dir);
    const out = formatGitOutput(result);
    expect(out.length).toBeGreaterThan(0);
    expect(out === "(no changes)" || /git|repository/i.test(out)).toBe(true);
  });

  it("path.join produces cwd-safe bash invocation", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "eh-bash-"));
    const session = new InMemorySession(newSessionId(), {
      cwd,
      startedAt: new Date().toISOString(),
      permissionMode: "danger-full-access",
    });
    const marker = path.join(cwd, "marker.txt");
    const result = await bashTool.execute(
      {
        command:
          process.platform === "win32"
            ? `echo xplat > "${marker.replace(/\\/g, "/")}"`
            : `echo xplat > "${marker}"`,
      },
      {
        cwd,
        session,
        abortSignal: AbortSignal.timeout(15_000),
      },
    );
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toMatch(/xplat|exit code: 0/i);
  });
});
