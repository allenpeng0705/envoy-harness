/**
 * Phase A / Item 6 — `/plan` REPL command tests.
 *
 * The plan-mode REPL command is a sub-arg dispatcher
 * (same shape as `/memory` and `/profile`): one
 * slash slot, seven subcommands. The state machine
 * itself is tested in `state.test.ts`; the tests in
 * this file focus on the REPL command's behavior —
 * arg parsing, friendly error messages, and the
 * round-trip from REPL → session plan state.
 *
 * **Coverage:**
 * 1. Default subcommand (no args) → "no active plan"
 *    hint when no plan exists.
 * 2. `enter` → activates plan mode on the session.
 * 3. `edit <text>` → sets the plan text on the
 *    session (after `enter`).
 * 4. `show` → prints the plan text.
 * 5. `propose` + `approve` → marks as approved; the
 *    session's plan state is `approved`.
 * 6. `reject [reason]` → marks as rejected with the
 *    reason; the session's plan state is `rejected`
 *    + `rejectionReason` is set.
 * 7. `exit` → leaves plan mode; the plan text +
 *    status are preserved.
 * 8. Invalid transitions surface a friendly error
 *    (e.g. `approve` before `propose`).
 * 9. Unknown subcommand → "usage: ..." error.
 *
 * **Hermetic:** every test drives the REPL with a
 * fake line reader. No real git, no LLM call, no
 * real filesystem.
 *
 * **Session injection:** the tests use the
 * `createSession` factory option to construct a
 * real `InMemorySession` outside the REPL. The REPL
 * uses it (and the agent wraps it); after the REPL
 * exits, the tests assert on the session's plan
 * state via `session.getPlan()`. This is the
 * canonical pattern for REPL tests that need to
 * inspect session-level state (F14.2).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  InMemorySession,
  newSessionId,
  runRepl,
  type PlanState,
  type Session,
  type SessionMetadata,
} from "../../src/index.js";
import {
  StringWritable,
  fakeLineReader,
  makeArgs,
  scriptedTextModel,
} from "../helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-repl-plan-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Drive the REPL with a series of lines, using a
 * caller-supplied session so the test can assert
 * on the plan state after the REPL exits. Returns
 * `{ out, err, session }` — `out.data` / `err.data`
 * are the accumulated stdout / stderr, and
 * `session.getPlan()` is the persisted plan state.
 */
async function drive(
  lines: ReadonlyArray<string>,
  cwd: string = tmpDir,
): Promise<{ out: StringWritable; err: StringWritable; session: Session }> {
  const out = new StringWritable();
  const err = new StringWritable();
  const model = scriptedTextModel("(unused)");
  const meta: SessionMetadata = {
    cwd,
    permissionMode: "workspace-write",
    startedAt: new Date().toISOString(),
    title: "test",
  };
  const session = new InMemorySession(newSessionId(), meta);
  await runRepl({
    model,
    args: makeArgs({}, { repl: true }),
    lineReader: fakeLineReader([...lines, "/quit"]),
    cwd,
    createSession: async () => session,
    stdout: out,
    stderr: err,
    historyPath: "",
  });
  return { out, err, session };
}

/** Convenience: read the plan state from a session. */
function readPlan(session: Session): PlanState | undefined {
  return session.getPlan();
}

// ---------------------------------------------------------------------------
// 1. Default subcommand: no args → "no active plan"
// ---------------------------------------------------------------------------

describe("/plan: default subcommand", () => {
  it("prints a 'no active plan' hint when no plan exists", async () => {
    const { out } = await drive(["/plan"]);
    expect(out.data).toContain("no active plan");
  });
});

// ---------------------------------------------------------------------------
// 2. enter — activates plan mode
// ---------------------------------------------------------------------------

describe("/plan: enter", () => {
  it("activates plan mode and reports status: draft", async () => {
    const { out, session } = await drive(["/plan enter"]);
    expect(out.data).toContain("plan mode: entered");
    expect(out.data).toContain("status: draft");
    const plan = readPlan(session);
    expect(plan?.active).toBe(true);
    expect(plan?.reviewStatus).toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// 3. edit — sets the plan text (after enter)
// ---------------------------------------------------------------------------

describe("/plan: edit", () => {
  it("sets the plan text and reports the new char count", async () => {
    const { out, session } = await drive([
      "/plan enter",
      "/plan edit step 1: build X",
    ]);
    expect(out.data).toContain("plan updated");
    expect(out.data).toContain("status reverted to draft");
    const plan = readPlan(session);
    expect(plan?.planText).toBe("step 1: build X");
  });

  it("errors when called without a text argument", async () => {
    const { out, err } = await drive(["/plan enter", "/plan edit"]);
    expect(err.data).toContain("usage: /plan edit <text>");
    // The success line is NOT printed.
    expect(out.data).not.toContain("plan updated");
  });
});

// ---------------------------------------------------------------------------
// 4. show — prints the plan text
// ---------------------------------------------------------------------------

describe("/plan: show", () => {
  it("prints the plan text after edit", async () => {
    const { out } = await drive([
      "/plan enter",
      "/plan edit step 1: build X; step 2: verify",
      "/plan show",
    ]);
    expect(out.data).toContain("--- plan");
    expect(out.data).toContain("step 1: build X; step 2: verify");
    expect(out.data).toMatch(/status: draft/);
  });

  it("prints an empty-plan hint when active but no text yet", async () => {
    const { out } = await drive(["/plan enter", "/plan show"]);
    expect(out.data).toContain("plan is empty");
    expect(out.data).toContain("status: draft");
  });
});

// ---------------------------------------------------------------------------
// 5. propose + approve — marks as approved
// ---------------------------------------------------------------------------

describe("/plan: propose + approve", () => {
  it("walks the full lifecycle and marks the plan as approved", async () => {
    const { out, session } = await drive([
      "/plan enter",
      "/plan edit do X then Y",
      "/plan propose",
      "/plan approve",
    ]);
    expect(out.data).toContain("plan proposed");
    expect(out.data).toContain("plan approved");
    expect(out.data).toContain("injected as a top-priority fragment");
    // The session's plan state is the source of truth.
    const plan = readPlan(session);
    expect(plan).toBeDefined();
    expect(plan?.active).toBe(true);
    expect(plan?.reviewStatus).toBe("approved");
    expect(plan?.planText).toBe("do X then Y");
  });
});

// ---------------------------------------------------------------------------
// 6. reject — records a reason
// ---------------------------------------------------------------------------

describe("/plan: reject", () => {
  it("marks as rejected with a reason and stores it on the session", async () => {
    const { out, session } = await drive([
      "/plan enter",
      "/plan edit do X",
      "/plan propose",
      "/plan reject too vague",
    ]);
    expect(out.data).toContain("plan rejected: too vague");
    const plan = readPlan(session);
    expect(plan?.reviewStatus).toBe("rejected");
    expect(plan?.rejectionReason).toBe("too vague");
  });

  it("accepts a bare reject with no reason", async () => {
    const { out, session } = await drive([
      "/plan enter",
      "/plan edit do X",
      "/plan propose",
      "/plan reject",
    ]);
    expect(out.data).toMatch(/^plan rejected/m);
    const plan = readPlan(session);
    expect(plan?.reviewStatus).toBe("rejected");
    expect(plan?.rejectionReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. exit — leaves plan mode (keeps text + status)
// ---------------------------------------------------------------------------

describe("/plan: exit", () => {
  it("leaves plan mode and preserves the plan text", async () => {
    const { out, session } = await drive([
      "/plan enter",
      "/plan edit do X",
      "/plan exit",
    ]);
    expect(out.data).toContain("plan mode: exited");
    const plan = readPlan(session);
    expect(plan?.active).toBe(false);
    expect(plan?.planText).toBe("do X");
  });
});

// ---------------------------------------------------------------------------
// 8. invalid transitions surface a friendly error
// ---------------------------------------------------------------------------

describe("/plan: invalid transitions", () => {
  it("surfaces a friendly error on 'approve' before 'propose'", async () => {
    const { err, out } = await drive([
      "/plan enter",
      "/plan edit do X",
      "/plan approve",
    ]);
    // The state machine throws "cannot approve a plan
    // in status 'draft'". The REPL command unwraps
    // the message and prepends "error: ".
    expect(err.data).toContain("error:");
    expect(err.data).toContain("cannot approve a plan in status 'draft'");
    // The success line is NOT printed.
    expect(out.data).not.toContain("plan approved");
  });
});

// ---------------------------------------------------------------------------
// 9. unknown subcommand
// ---------------------------------------------------------------------------

describe("/plan: unknown subcommand", () => {
  it("prints a usage hint", async () => {
    const { err } = await drive(["/plan bogus"]);
    expect(err.data).toContain("usage: /plan");
    expect(err.data).toMatch(/enter|show|edit|propose|approve|reject|exit/);
  });
});
