/**
 * Durable session diagnostics — retries and sandbox denials recorded in
 * the session, not only in a trace stream.
 *
 * **Why this is not the tracer.** The default tracer is `NullTracer`, so a
 * retry that happened is invisible after the fact. A session that survived
 * a rate-limit storm and one that never hit trouble look identical on
 * `--resume`. These records ride in the session header, which is already
 * rewritten atomically, and they are bounded so a long-lived session's
 * header cannot grow without limit.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  Agent,
  DEFAULT_RETRY_POLICY,
  MAX_SESSION_DIAGNOSTICS,
  PersistedSession,
  SessionStore,
  ToolRegistry,
  appendDiagnostic,
  type SessionDiagnosticEvent,
  type SessionMetadata,
} from "../src/index.js";
import { HookRegistry } from "../src/hooks/index.js";
import { InMemorySession, newSessionId } from "../src/session.js";
import { FakeModel, textResponse } from "./fixtures/fake-model.js";

function metadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    cwd: "/proj",
    permissionMode: "read-only",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function event(n: number): SessionDiagnosticEvent {
  return { kind: "retry", at: `2026-01-01T00:00:0${n % 10}.000Z`, retryNumber: n };
}

describe("appendDiagnostic", () => {
  it("creates the log on first use", () => {
    const meta = metadata();
    expect(meta.diagnostics).toBeUndefined();
    appendDiagnostic(meta, event(1));
    expect(meta.diagnostics).toHaveLength(1);
  });

  it("caps the log, keeping the NEWEST records", () => {
    const meta = metadata();
    for (let i = 1; i <= MAX_SESSION_DIAGNOSTICS + 5; i += 1) {
      appendDiagnostic(meta, event(i));
    }
    expect(meta.diagnostics).toHaveLength(MAX_SESSION_DIAGNOSTICS);
    // Oldest five were dropped, not the newest.
    expect(meta.diagnostics?.[0]?.retryNumber).toBe(6);
    expect(meta.diagnostics?.at(-1)?.retryNumber).toBe(MAX_SESSION_DIAGNOSTICS + 5);
  });
});

describe("InMemorySession diagnostics", () => {
  it("records and reads back", () => {
    const session = new InMemorySession(newSessionId(), metadata());
    expect(session.diagnostics?.()).toEqual([]);
    session.recordDiagnostic?.(event(1));
    expect(session.diagnostics?.()).toHaveLength(1);
  });
});

describe("PersistedSession diagnostics survive a resume", () => {
  it("round-trips records through the JSONL header", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "envoy-diag-"));
    try {
      const store = new SessionStore({ dir });
      const created = await store.create(metadata());
      created.appendMessage("user", [{ type: "text", text: "hi" }]);
      created.recordDiagnostic?.({
        kind: "retry",
        at: "2026-01-01T00:00:00.000Z",
        iteration: 3,
        failureClass: "RATE_LIMIT",
        retryNumber: 2,
        delayMs: 1000,
        detail: "transient RATE_LIMIT",
      });
      created.recordDiagnostic?.({
        kind: "sandbox-denied",
        at: "2026-01-01T00:00:05.000Z",
        backend: "landlock",
        reason: "permission_denied",
        path: "/etc/hosts",
      });
      await created.close();

      const reopened = await PersistedSession.open(
        path.join(dir, `${created.id}.jsonl`),
      );
      const records = reopened.diagnostics?.() ?? [];
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        kind: "retry",
        iteration: 3,
        failureClass: "RATE_LIMIT",
        retryNumber: 2,
        delayMs: 1000,
      });
      expect(records[1]).toMatchObject({
        kind: "sandbox-denied",
        backend: "landlock",
        reason: "permission_denied",
        path: "/etc/hosts",
      });
      // The transcript itself is untouched by diagnostics.
      expect(reopened.messages).toHaveLength(1);
      await reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the agent loop records retries durably", () => {
  const fastRetry = {
    ...DEFAULT_RETRY_POLICY,
    maxRetries: 2,
    initialDelayMs: 1,
    maxDelayMs: 5,
    jitterRatio: 0,
  };

  function agentFor(session: InMemorySession, model: FakeModel): Agent {
    return new Agent({
      model,
      tools: new ToolRegistry(),
      hooks: new HookRegistry(),
      session,
      cwd: "/proj",
      retryPolicy: fastRetry,
    });
  }

  it("records a retry that then succeeded", async () => {
    const session = new InMemorySession(newSessionId(), metadata());
    const model = new FakeModel([
      { error: new Error("rate limit exceeded") },
      textResponse("recovered"),
    ]);
    const result = await agentFor(session, model).run("hi");
    expect(result.stopReason).toBe("end_turn");

    const records = session.diagnostics?.() ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "retry",
      failureClass: "RATE_LIMIT",
      retryNumber: 1,
    });
    expect(records[0]?.delayMs).toBeGreaterThan(0);
  });

  it("records exhaustion when the retries run out", async () => {
    const session = new InMemorySession(newSessionId(), metadata());
    const model = new FakeModel([
      { error: new Error("rate limit exceeded") },
      { error: new Error("rate limit exceeded") },
      { error: new Error("rate limit exceeded") },
    ]);
    await agentFor(session, model).run("hi");

    const records = session.diagnostics?.() ?? [];
    // Two retries happened, then the third failure exhausted the budget.
    expect(records.map((r) => r.kind)).toEqual([
      "retry",
      "retry",
      "retry-exhausted",
    ]);
    expect(records[2]?.detail).toContain("exhausted");
  });

  it("records a NON-retryable failure as exhausted without retrying", async () => {
    const session = new InMemorySession(newSessionId(), metadata());
    const model = new FakeModel([
      { error: new Error("invalid api key") },
    ]);
    await agentFor(session, model).run("hi");

    const records = session.diagnostics?.() ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("retry-exhausted");
    expect(records[0]?.detail).toContain("not a transient failure");
  });

  it("records an abandonment when the turn is cancelled mid-backoff", async () => {
    const session = new InMemorySession(newSessionId(), metadata());
    // A long backoff guarantees the abort lands while we are sleeping.
    const model = new FakeModel([
      { error: new Error("rate limit exceeded") },
      textResponse("never reached"),
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      hooks: new HookRegistry(),
      session,
      cwd: "/proj",
      retryPolicy: {
        ...DEFAULT_RETRY_POLICY,
        maxRetries: 3,
        initialDelayMs: 5_000,
        maxDelayMs: 5_000,
        jitterRatio: 0,
      },
    });
    const pending = agent.run("hi");
    // Abort only once the retry has been SCHEDULED, so the cancel provably
    // lands inside the backoff rather than before the first attempt. A
    // fixed delay would race the model call under load.
    const abortDeadline = Date.now() + 5_000;
    while (
      (session.diagnostics?.() ?? []).length === 0 &&
      Date.now() < abortDeadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    agent.abort("user cancelled");
    const result = await pending;
    expect(result.stopReason).toBe("aborted");

    const records = session.diagnostics?.() ?? [];
    // `retry` is written when the retry is SCHEDULED (the delay has to be
    // announced before we sleep); `retry-abandoned` when the cancel landed
    // during the backoff. Both matter: one says a retry was in flight, the
    // other says it never ran.
    expect(records.map((r) => r.kind)).toEqual(["retry", "retry-abandoned"]);
    expect(records[1]?.detail).toContain("during backoff");
  });
});
