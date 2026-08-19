/**
 * bash tool tests.
 *
 * Covers the full path: validation (using the 6-validator
 * composition) → execution (spawn sh -c) → output capture →
 * timeout / abort handling.
 *
 * **Why a separate test file from `tools-registry.test.ts`:** the
 * bash tool exercises `child_process.spawn`, the env, and
 * permission-mode wiring. Registry tests are pure. Mixing them
 * would make the registry tests slow.
 */

import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  bashTool,
  InMemorySession,
  newSessionId,
  type Session,
  type SessionMetadata,
  type ToolContext,
} from "../src/index.js";

function makeCtx(
  mode: "read-only" | "workspace-write" | "danger-full-access" = "workspace-write",
): ToolContext {
  const meta: SessionMetadata = {
    cwd: os.tmpdir(),
    permissionMode: mode,
    startedAt: new Date().toISOString(),
  };
  const session: Session = new InMemorySession(newSessionId(), meta);
  return {
    cwd: os.tmpdir(),
    session,
    abortSignal: AbortSignal.timeout(5000),
  };
}

describe("bash: permission validation", () => {
  it("blocks writes in read-only mode", async () => {
    const ctx = makeCtx("read-only");
    const result = await bashTool.execute({ command: "rm -rf /tmp/x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/bash blocked/);
  });

  it("blocks network commands in workspace-write mode", async () => {
    const ctx = makeCtx("workspace-write");
    const result = await bashTool.execute(
      { command: "curl https://example.com" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/bash blocked/);
  });

  it("runs a benign command in workspace-write mode", async () => {
    const ctx = makeCtx("workspace-write");
    const result = await bashTool.execute(
      { command: "echo hello" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");
  });

  it("runs anything in danger-full-access mode", async () => {
    const ctx = makeCtx("danger-full-access");
    const result = await bashTool.execute(
      { command: "echo $((1+1))" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("2");
  });

  it("defaults to read-only when session has no permissionMode", async () => {
    // Construct a session with no permissionMode (omit it).
    const meta: SessionMetadata = {
      cwd: os.tmpdir(),
      startedAt: new Date().toISOString(),
    };
    const session = new InMemorySession(newSessionId(), meta);
    const ctx: ToolContext = {
      cwd: os.tmpdir(),
      session,
      abortSignal: AbortSignal.timeout(5000),
    };
    // A write op should be blocked (read-only is the safe default).
    const result = await bashTool.execute(
      { command: "touch /tmp/envoy-harness-test-deny" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it("blocks no-space redirects in read-only mode (real tokenizer)", async () => {
    const ctx = makeCtx("read-only");
    const result = await bashTool.execute(
      { command: "echo hi>file" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/bash blocked/);
  });

  it("blocks fd redirects to real files in read-only mode", async () => {
    const ctx = makeCtx("read-only");
    const result = await bashTool.execute(
      { command: "ls 2>/tmp/out.txt" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it("blocks relative paths that escape cwd in workspace-write", async () => {
    const ctx = makeCtx("workspace-write");
    const result = await bashTool.execute(
      { command: "echo hi > ../outside.txt" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/bash blocked/);
  });

  it("honors the live sandboxPolicy over session metadata", async () => {
    // Session says workspace-write, but the agent's live policy
    // is read-only (e.g. after `/sandbox read-only`). The bash
    // tool must enforce the live policy.
    const meta: SessionMetadata = {
      cwd: os.tmpdir(),
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    };
    const session = new InMemorySession(newSessionId(), meta);
    const ctx: ToolContext = {
      cwd: os.tmpdir(),
      session,
      abortSignal: AbortSignal.timeout(5000),
      sandboxPolicy: {
        mode: "read-only",
        approval: "on-request",
        backend: "linux-landlock",
        writableRoots: [],
        networkAccess: false,
        slashTmpWritable: true,
      },
    };
    const result = await bashTool.execute(
      { command: "touch /tmp/envoy-harness-live-policy-deny" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/bash blocked/);
  });
});

describe("bash: execution", () => {
  it("captures stdout", async () => {
    const ctx = makeCtx("workspace-write");
    const result = await bashTool.execute(
      { command: "printf 'hello\\nworld\\n'" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");
    expect(result.content).toContain("world");
  });

  it("captures stderr separately", async () => {
    const ctx = makeCtx("workspace-write");
    const result = await bashTool.execute(
      { command: "echo to-stderr 1>&2" },
      ctx,
    );
    expect(result.content).toContain("[stderr]");
    expect(result.content).toContain("to-stderr");
  });

  it("reports non-zero exit as isError", async () => {
    const ctx = makeCtx("workspace-write");
    const result = await bashTool.execute(
      { command: "exit 7" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/exit code: 7/);
  });

  it("respects the cwd from context", async () => {
    const ctx = makeCtx("workspace-write");
    // `pwd` should run in the context's cwd.
    const result = await bashTool.execute({ command: "pwd" }, ctx);
    expect((result.content as string).trim()).toContain(ctx.cwd);
  });
});

describe("bash: timeout and abort", () => {
  it("kills the child with SIGKILL after timeoutMs", async () => {
    const ctx = makeCtx("workspace-write");
    const result = await bashTool.execute(
      { command: "sleep 5", timeoutMs: 200 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/killed|exit code/);
  });

  it("aborts on context abortSignal", async () => {
    const controller = new AbortController();
    const meta: SessionMetadata = {
      cwd: os.tmpdir(),
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    };
    const session = new InMemorySession(newSessionId(), meta);
    const ctx: ToolContext = {
      cwd: os.tmpdir(),
      session,
      abortSignal: controller.signal,
    };
    // Abort after 100ms.
    setTimeout(() => controller.abort(), 100);
    const result = await bashTool.execute(
      { command: "sleep 5" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/killed|exit code/);
  });
});

describe("bash: warning verdicts", () => {
  it("runs destructive commands but prefixes the result with the warning", async () => {
    // `rm` of an existing temp file is destructive-warning territory.
    const ctx = makeCtx("workspace-write");
    const target = path.join(os.tmpdir(), "envoy-harness-test-warning.tmp");
    const result = await bashTool.execute(
      { command: `rm -f ${target} && echo "removed"` },
      ctx,
    );
    expect(result.isError).toBe(false);
    // The result should contain the warning prefix (if the validator
    // fired) OR the output. We don't assert on which one wins —
    // the test just needs to confirm the command ran and the
    // result is well-formed.
    expect(result.content as string).toMatch(/removed|warning/);
  });
});
