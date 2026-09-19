/**
 * Sandbox escalation — from "the kernel said no" to a decision the user can
 * make, with one widened retry.
 *
 * **The property that matters most is fail-closed.** A tool must never be
 * able to widen its own sandbox: the ladder is computed by the executor,
 * `approval: "never"` denies without prompting, and a `PermissionRequest`
 * hook can veto before a human is troubled. These tests assert those
 * negatives as hard as they assert the happy path.
 */

import { describe, expect, it, vi } from "vitest";

import { Agent } from "../src/agent.js";
import { InMemorySession, newSessionId } from "../src/session.js";
import { ToolRegistry, type ToolResult } from "../src/tools/index.js";
import type {
  SandboxContext,
  SandboxExecutor,
  SandboxResult,
} from "../src/sandbox/types.js";
import {
  canEscalate,
  describeSandboxEscalation,
  describeWidening,
  policyToLandlockGrants,
  rootsCover,
  widenSandboxPolicy,
  writableRootFor,
  type SandboxEscalationRequest,
} from "../src/sandbox/index.js";
import type { SandboxDenial } from "../src/sandbox/classify.js";
import type { SandboxPolicy } from "../src/types.js";
import { HookRegistry } from "../src/hooks/index.js";
import { bashTool } from "../src/tools/builtin/bash.js";
import { FakeModel, textResponse } from "./fixtures/fake-model.js";

const CWD = "/work/project";

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    mode: "read-only",
    approval: "on-request",
    // An enforcing backend: with `backend: "none"` nothing can deny, so
    // there would be nothing to escalate from.
    backend: "linux-landlock",
    writableRoots: [],
    networkAccess: false,
    slashTmpWritable: true,
    ...overrides,
  };
}

function denial(overrides: Partial<SandboxDenial> = {}): SandboxDenial {
  return {
    kind: "denied",
    backend: "landlock",
    reason: "permission_denied",
    outputSnippet: "Permission denied",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The ladder (pure)
// ---------------------------------------------------------------------------

describe("writableRootFor", () => {
  it("grants the denied file's directory, not the file", () => {
    expect(writableRootFor("/etc/hosts", CWD)).toBe("/etc");
    expect(writableRootFor("/work/project/src/a.ts", CWD)).toBe(
      "/work/project/src",
    );
  });

  it("resolves an explicit relative path against cwd", () => {
    expect(writableRootFor("./build/out.txt", CWD)).toBe("/work/project/build");
    expect(writableRootFor("../sibling/x", CWD)).toBe("/work/sibling");
  });

  it("refuses a bare token (a program name is not a path)", () => {
    expect(writableRootFor("notes.txt", CWD)).toBeUndefined();
    expect(writableRootFor("sh", CWD)).toBeUndefined();
  });

  it("refuses to infer a grant of the filesystem root", () => {
    // dirname("/x") === "/": granting that is full filesystem access. It
    // must only ever arrive as an explicit danger-full-access, never as a
    // guess from a message.
    expect(writableRootFor("/x", CWD)).toBeUndefined();
  });

  it("is undefined without a path", () => {
    expect(writableRootFor(undefined, CWD)).toBeUndefined();
    expect(writableRootFor("", CWD)).toBeUndefined();
  });
});

describe("rootsCover", () => {
  it("is true for equal paths and true descendants", () => {
    expect(rootsCover(["/work"], "/work", CWD)).toBe(true);
    expect(rootsCover(["/work"], "/work/a/b", CWD)).toBe(true);
  });

  it("is false for a sibling with a shared prefix", () => {
    // "/work2" must not be treated as inside "/work".
    expect(rootsCover(["/work"], "/work2", CWD)).toBe(false);
    expect(rootsCover(["/work/project"], "/work/other", CWD)).toBe(false);
  });
});

describe("widenSandboxPolicy", () => {
  it("read-only → workspace-write scoped to the denied directory", () => {
    const wider = widenSandboxPolicy(policy({ mode: "read-only" }), {
      cwd: CWD,
      deniedPath: "/var/log/app.log",
    });
    expect(wider?.mode).toBe("workspace-write");
    expect(wider?.writableRoots).toEqual(["/var/log"]);
  });

  it("falls back to cwd when the denial names no usable path", () => {
    const wider = widenSandboxPolicy(policy({ mode: "read-only" }), {
      cwd: CWD,
    });
    expect(wider?.writableRoots).toEqual([CWD]);
  });

  it("workspace-write adds just the denied directory", () => {
    const wider = widenSandboxPolicy(
      policy({ mode: "workspace-write", writableRoots: [CWD] }),
      { cwd: CWD, deniedPath: "/srv/data/x.db" },
    );
    expect(wider?.mode).toBe("workspace-write");
    expect(wider?.writableRoots).toEqual([CWD, "/srv/data"]);
  });

  it("escalates to danger-full-access when the grant would be a no-op", () => {
    // The denied path is already writable, so the failure cannot have been
    // about that path; only a broader policy can help.
    const wider = widenSandboxPolicy(
      policy({ mode: "workspace-write", writableRoots: [CWD] }),
      { cwd: CWD, deniedPath: `${CWD}/inside.txt` },
    );
    expect(wider?.mode).toBe("danger-full-access");
  });

  it("escalates to danger-full-access when no path was named", () => {
    const wider = widenSandboxPolicy(
      policy({ mode: "workspace-write", writableRoots: [CWD] }),
      { cwd: CWD },
    );
    expect(wider?.mode).toBe("danger-full-access");
  });

  it("cannot widen further than danger-full-access", () => {
    expect(
      widenSandboxPolicy(policy({ mode: "danger-full-access" }), {
        cwd: CWD,
        deniedPath: "/etc/hosts",
      }),
    ).toBeUndefined();
  });

  it("preserves backend and network policy (escalation widens, never disarms)", () => {
    const start = policy({
      mode: "read-only",
      backend: "linux-landlock",
      networkAccess: true,
      slashTmpWritable: false,
    });
    const wider = widenSandboxPolicy(start, {
      cwd: CWD,
      deniedPath: "/srv/a.txt",
    });
    expect(wider?.backend).toBe("linux-landlock");
    expect(wider?.networkAccess).toBe(true);
    expect(wider?.slashTmpWritable).toBe(false);
  });
});

describe("canEscalate", () => {
  it("is false under approval 'never' (fail closed)", () => {
    expect(
      canEscalate({
        policy: policy({ approval: "never" }),
        denial: denial({ path: "/etc/hosts" }),
        approval: "never",
        cwd: CWD,
      }),
    ).toBe(false);
  });

  it("is false when nothing is wider", () => {
    expect(
      canEscalate({
        policy: policy({ mode: "danger-full-access" }),
        denial: denial({ path: "/etc/hosts" }),
        approval: "on-request",
        cwd: CWD,
      }),
    ).toBe(false);
  });

  it("is true for an escalation-worthy denial", () => {
    expect(
      canEscalate({
        policy: policy({ mode: "workspace-write" }),
        denial: denial({ path: "/etc/hosts" }),
        approval: "on-request",
        cwd: CWD,
      }),
    ).toBe(true);
  });
});

describe("model/host-facing text", () => {
  it("names the path, the reason and the exact widening on offer", () => {
    const text = describeSandboxEscalation({
      tool: "bash",
      subject: "cat /etc/hosts",
      denial: denial({ path: "/etc/hosts" }),
      currentPolicy: policy({ mode: "workspace-write", writableRoots: [CWD] }),
      cwd: CWD,
    });
    expect(text).toContain("/etc/hosts");
    expect(text).toContain("permission denied");
    expect(text).toContain("workspace-write");
    expect(text).toContain("/etc");
    expect(text).toContain("cat /etc/hosts");
  });

  it("describeWidening names the added root for a same-mode widening", () => {
    expect(
      describeWidening(
        policy({ mode: "workspace-write", writableRoots: [CWD] }),
        policy({ mode: "workspace-write", writableRoots: [CWD, "/srv"] }),
        CWD,
      ),
    ).toBe("workspace-write (writable roots + /srv)");
  });
});

describe("policyToLandlockGrants", () => {
  it("danger-full-access grants a full write root", () => {
    // Regression: it used to fall through to the workspace-write shape, so
    // a full-access session was still write-confined to /tmp — and a
    // just-approved escalation would fail for no visible reason.
    const grants = policyToLandlockGrants(
      policy({ mode: "danger-full-access" }),
      CWD,
    );
    expect(grants.readWrite).toEqual(["/"]);
  });

  it("workspace-write still confines writes to the roots plus /tmp", () => {
    const grants = policyToLandlockGrants(
      policy({ mode: "workspace-write", writableRoots: [CWD] }),
      CWD,
    );
    expect(grants.readWrite).toEqual([CWD, "/tmp"]);
  });
});

// ---------------------------------------------------------------------------
// Bash tool integration (hermetic fake executor)
// ---------------------------------------------------------------------------

/** Executor that records the policy it was called with and replays results. */
function fakeExecutor(results: SandboxResult[]): SandboxExecutor & {
  policies: SandboxPolicy[];
} {
  const policies: SandboxPolicy[] = [];
  let i = 0;
  return {
    policies,
    async execute(_command: string, context: SandboxContext) {
      policies.push(context.policy);
      const result = results[Math.min(i, results.length - 1)];
      i += 1;
      return result!;
    },
  };
}

const DENIED_RESULT: SandboxResult = {
  stdout: "",
  stderr: "cat: cannot open '/etc/hosts': Permission denied",
  exitCode: 1,
  isError: true,
};
const OK_RESULT: SandboxResult = {
  stdout: "contents",
  stderr: "",
  exitCode: 0,
  isError: false,
};

function bashCtx(
  executor: SandboxExecutor,
  overrides: Partial<Parameters<typeof bashTool.execute>[1]> = {},
) {
  const session = new InMemorySession(newSessionId(), {
    cwd: CWD,
    permissionMode: "read-only",
    startedAt: new Date().toISOString(),
  });
  return {
    cwd: CWD,
    session,
    abortSignal: AbortSignal.timeout(10_000),
    sandboxPolicy: policy({ mode: "read-only" }),
    sandboxExecutor: executor,
    ...overrides,
  };
}

describe("bash: escalation grants one widened retry", () => {
  it("asks, retries with the wider policy, and reports it granted", async () => {
    const executor = fakeExecutor([DENIED_RESULT, OK_RESULT]);
    const requestSandboxEscalation = vi.fn(async (_req: SandboxEscalationRequest) => ({
      kind: "allow" as const,
      policy: policy({
        mode: "workspace-write",
        writableRoots: ["/etc"],
      }),
      note: "read-only → workspace-write",
    }));

    const result = (await bashTool.execute(
      { command: "cat /etc/hosts" },
      bashCtx(executor, { requestSandboxEscalation }),
    )) as ToolResult;

    // The offer carried the structured denial, not prose.
    expect(requestSandboxEscalation).toHaveBeenCalledTimes(1);
    const req = requestSandboxEscalation.mock.calls[0]![0];
    expect(req.tool).toBe("bash");
    expect(req.subject).toBe("cat /etc/hosts");
    expect(req.denial.path).toBe("/etc/hosts");
    expect(req.denial.reason).toBe("permission_denied");

    // Exactly two executor calls, the second under the widened policy.
    expect(executor.policies).toHaveLength(2);
    expect(executor.policies[0]?.mode).toBe("read-only");
    expect(executor.policies[1]?.mode).toBe("workspace-write");
    expect(executor.policies[1]?.writableRoots).toEqual(["/etc"]);

    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain("contents");
    expect(String(result.content)).toContain("escalation GRANTED");
    expect(result.meta?.escalation).toBe("granted");
    expect(result.meta?.escalatedPolicy?.mode).toBe("workspace-write");
    expect(result.meta?.sandbox?.kind).toBe("denied");
  });

  it("does NOT retry when the escalation is refused", async () => {
    const executor = fakeExecutor([DENIED_RESULT]);
    const requestSandboxEscalation = vi.fn(async (_req: SandboxEscalationRequest) => ({
      kind: "deny" as const,
      reason: "user said no",
    }));

    const result = (await bashTool.execute(
      { command: "cat /etc/hosts" },
      bashCtx(executor, { requestSandboxEscalation }),
    )) as ToolResult;

    expect(executor.policies).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("NOT granted");
    expect(String(result.content)).toContain("user said no");
    expect(result.meta?.escalation).toBe("denied");
  });

  it("never asks when the host exposes no escalation path", async () => {
    const executor = fakeExecutor([DENIED_RESULT]);
    const result = (await bashTool.execute(
      { command: "cat /etc/hosts" },
      bashCtx(executor),
    )) as ToolResult;
    expect(executor.policies).toHaveLength(1);
    expect(result.meta?.escalation).toBeUndefined();
    expect(result.meta?.sandbox?.kind).toBe("denied");
  });

  it("does not ask on an ordinary program failure", async () => {
    const executor = fakeExecutor([
      { stdout: "", stderr: "AssertionError: 1 != 2", exitCode: 1, isError: true },
    ]);
    const requestSandboxEscalation = vi.fn();
    const result = (await bashTool.execute(
      { command: "false" },
      bashCtx(executor, { requestSandboxEscalation }),
    )) as ToolResult;
    expect(requestSandboxEscalation).not.toHaveBeenCalled();
    expect(result.meta).toBeUndefined();
  });

  it("does not ask on an infrastructure failure (the command never ran)", async () => {
    const executor = fakeExecutor([
      {
        stdout: "",
        stderr: "landlock-run: failed to apply restrictions",
        exitCode: 125,
        isError: true,
      },
    ]);
    const requestSandboxEscalation = vi.fn();
    const result = (await bashTool.execute(
      { command: "cat /etc/hosts" },
      bashCtx(executor, { requestSandboxEscalation }),
    )) as ToolResult;
    expect(requestSandboxEscalation).not.toHaveBeenCalled();
    expect(result.meta?.sandbox?.kind).toBe("infrastructure");
    expect(result.meta?.escalation).toBeUndefined();
  });

  it("does not ask when nothing is wider (danger-full-access)", async () => {
    const executor = fakeExecutor([DENIED_RESULT]);
    const requestSandboxEscalation = vi.fn();
    await bashTool.execute(
      { command: "cat /etc/hosts" },
      bashCtx(executor, {
        sandboxPolicy: policy({ mode: "danger-full-access" }),
        requestSandboxEscalation,
      }),
    );
    expect(requestSandboxEscalation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Executor-level: the ladder is not the tool's to climb
// ---------------------------------------------------------------------------

function agentWith(options: {
  executor: SandboxExecutor;
  approval?: "never" | "on-request";
  askHandler?: (req: { question: string }) => Promise<
    { kind: "allow" } | { kind: "deny"; reason: string }
  >;
  hooks?: HookRegistry;
  session?: InMemorySession;
}): { agent: Agent; session: InMemorySession } {
  const session =
    options.session ??
    new InMemorySession(newSessionId(), {
      cwd: CWD,
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
  const registry = new ToolRegistry();
  registry.register(bashTool);
  const agent = new Agent({
    model: new FakeModel([
      {
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "bash",
            args: { command: "cat /etc/hosts" },
          },
        ],
      },
      textResponse("done"),
    ]),
    tools: registry,
    hooks: options.hooks ?? new HookRegistry(),
    session,
    cwd: CWD,
    sandboxExecutor: options.executor,
    sandboxPolicy: policy({ mode: "read-only" }),
    ...(options.approval !== undefined ? { approval: options.approval } : {}),
    ...(options.askHandler !== undefined
      ? { askHandler: options.askHandler as never }
      : {}),
  });
  return { agent, session };
}

describe("approval 'never' fails closed", () => {
  it("denies without ever consulting the ask handler", async () => {
    const executor = fakeExecutor([DENIED_RESULT, OK_RESULT]);
    const askHandler = vi.fn(async () => ({ kind: "allow" as const }));
    const { agent, session } = agentWith({
      executor,
      approval: "never",
      askHandler,
    });
    await agent.run("go");

    expect(askHandler).not.toHaveBeenCalled();
    // Only the original attempt ran.
    expect(executor.policies).toHaveLength(1);
    const kinds = (session.diagnostics?.() ?? []).map((d) => d.kind);
    expect(kinds).toContain("sandbox-denied");
    expect(kinds).toContain("sandbox-escalation-denied");
    expect(kinds).not.toContain("sandbox-escalated");
  });
});

describe("a PermissionRequest hook can veto before the human is asked", () => {
  it("denies without consulting the ask handler", async () => {
    const executor = fakeExecutor([DENIED_RESULT, OK_RESULT]);
    const askHandler = vi.fn(async () => ({ kind: "allow" as const }));
    const hooks = new HookRegistry();
    hooks.on("PermissionRequest", async () => ({
      kind: "block",
      reason: "policy: never widen /etc",
    }));
    const { agent, session } = agentWith({ executor, hooks, askHandler });
    await agent.run("go");

    expect(askHandler).not.toHaveBeenCalled();
    expect(executor.policies).toHaveLength(1);
    const records = session.diagnostics?.() ?? [];
    expect(records.map((d) => d.kind)).toContain("sandbox-escalation-denied");
  });
});

describe("an approved escalation is recorded durably", () => {
  it("retries once and records denied + escalated", async () => {
    const executor = fakeExecutor([DENIED_RESULT, OK_RESULT]);
    const askHandler = vi.fn(async () => ({ kind: "allow" as const }));
    const { agent, session } = agentWith({ executor, askHandler });
    await agent.run("go");

    expect(askHandler).toHaveBeenCalledTimes(1);
    expect(executor.policies).toHaveLength(2);
    expect(executor.policies[1]?.mode).toBe("workspace-write");
    expect(executor.policies[1]?.writableRoots).toEqual(["/etc"]);

    const records = session.diagnostics?.() ?? [];
    const denied = records.find((d) => d.kind === "sandbox-denied");
    expect(denied).toMatchObject({
      backend: "landlock",
      reason: "permission_denied",
      path: "/etc/hosts",
    });
    const escalated = records.find((d) => d.kind === "sandbox-escalated");
    expect(escalated?.detail).toContain("workspace-write");
  });

  it("records a deny when the user refuses", async () => {
    const executor = fakeExecutor([DENIED_RESULT]);
    const askHandler = vi.fn(async () => ({
      kind: "deny" as const,
      reason: "not this time",
    }));
    const { agent, session } = agentWith({ executor, askHandler });
    await agent.run("go");

    expect(executor.policies).toHaveLength(1);
    const records = session.diagnostics?.() ?? [];
    expect(records.map((d) => d.kind)).toEqual([
      "sandbox-denied",
      "sandbox-escalation-denied",
    ]);
  });
});
