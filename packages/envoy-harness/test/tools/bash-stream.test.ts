/**
 * Bash stdout streaming to protocol hosts via ToolContext.onToolOutput.
 */

import { describe, expect, it } from "vitest";

import { InMemorySession, newSessionId } from "../../src/session.js";
import { bashTool } from "../../src/tools/builtin/bash.js";

function ctx(cwd: string, onToolOutput?: (stdout: string) => void) {
  return {
    cwd,
    session: new InMemorySession(newSessionId(), {
      cwd,
      startedAt: new Date().toISOString(),
      permissionMode: "danger-full-access",
    }),
    abortSignal: AbortSignal.timeout(15_000),
    ...(onToolOutput !== undefined ? { onToolOutput } : {}),
  };
}

describe("bash onToolOutput", () => {
  it("emits stdout chunks while the command runs", async () => {
    const chunks: string[] = [];
    const result = await bashTool.execute(
      { command: "printf 'chunk-a\\nchunk-b'" },
      ctx(process.cwd(), (stdout) => chunks.push(stdout)),
    );
    expect(result.isError).toBeFalsy();
    expect(chunks.join("")).toContain("chunk-a");
    expect(String(result.content)).toContain("chunk-a");
  });

  it("streams through the sandbox executor path", async () => {
    const { NoopSandboxExecutor } = await import(
      "../../src/sandbox/types.js"
    );
    const chunks: string[] = [];
    const session = new InMemorySession(newSessionId(), {
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
      permissionMode: "danger-full-access",
    });
    const result = await bashTool.execute(
      { command: "printf 'via-exec'" },
      {
        cwd: process.cwd(),
        session,
        abortSignal: AbortSignal.timeout(15_000),
        sandboxExecutor: new NoopSandboxExecutor(),
        onToolOutput: (stdout) => chunks.push(stdout),
      },
    );
    expect(result.isError).toBeFalsy();
    expect(chunks.join("")).toContain("via-exec");
  });
});
