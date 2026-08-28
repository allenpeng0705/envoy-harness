/**
 * Tests for `src/interaction/ask-for-approval-shim.ts` —
 * the `AskForApproval` shim that delegates a hook's
 * `kind: "ask"` decision to the `UserQuestionService`.
 *
 * Covers:
 * 1. Default `["Yes", "No"]` options when no custom
 *    options are set.
 * 2. Custom `options` override (first two become
 *    Yes / No for the picker; the rest are dropped).
 * 3. The rendered prompt includes the tool name + a
 *    short arg summary (bash: command; read_file: path;
 *    unknown: JSON dump).
 * 4. Yes index → `allow`; No index → `deny`.
 * 5. Free-form "y" / "yes" / "Y" / "YES" → `allow`;
 *    anything else → `deny` (fail-closed).
 * 6. `no-provider` → `deny` with reason
 *    "no user channel".
 * 7. `aborted` / `timeout` → `deny` with that reason.
 * 8. Signal is forwarded.
 * 9. A custom `formatPrompt` override is honored.
 *
 * **Hermetic:** every test uses a fake
 * `UserQuestionService` (no real stdin / network).
 */

import { describe, expect, it, vi } from "vitest";

import { createAskForApprovalShim } from "../../src/interaction/ask-for-approval-shim.js";
import type {
  UserQuestionAnswer,
  UserQuestionProvider,
  UserQuestionRequest,
  UserQuestionService,
} from "../../src/interaction/user-questions.js";
import type { AskRequest } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A `UserQuestionService` that delegates to a fake
 *  provider returning the given answer. Records the
 *  provider's calls. */
function buildFakeService(answer: UserQuestionAnswer): {
  service: UserQuestionService;
  calls: UserQuestionRequest[];
} {
  const calls: UserQuestionRequest[] = [];
  const askSpy = vi.fn(
    async (req: UserQuestionRequest): Promise<UserQuestionAnswer> => {
      calls.push(req);
      return answer;
    },
  );
  const provider: UserQuestionProvider = {
    name: "fake",
    ask: askSpy,
  };
  let current: UserQuestionProvider | undefined = provider;
  return {
    calls,
    service: {
      registerProvider(p: UserQuestionProvider): () => void {
        if (current !== undefined) {
          throw new Error("already registered");
        }
        current = p;
        return () => {
          if (current === p) current = undefined;
        };
      },
      hasProvider: () => current !== undefined,
      providerName: () => current?.name,
      async ask(req: UserQuestionRequest): Promise<UserQuestionAnswer> {
        return current!.ask(req);
      },
    },
  };
}

/** Build a fresh `AskRequest` for the test. */
function makeAskReq(overrides: Partial<AskRequest> = {}): AskRequest {
  return {
    tool: "bash",
    args: { command: "rm -rf /" },
    question: "Run bash with this command?",
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Options forwarding
// ---------------------------------------------------------------------------

describe("createAskForApprovalShim — options forwarding", () => {
  it("sends the default ['Yes', 'No'] when no custom options are set", async () => {
    const { service, calls } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    const handler = createAskForApprovalShim({ service });
    await handler(makeAskReq());
    expect(calls[0]?.options).toEqual(["Yes", "No"]);
  });

  it("honors a custom options override (all entries are forwarded)", async () => {
    const { service, calls } = buildFakeService({
      value: "Allow",
      optionIndex: 0,
      cancelled: false,
    });
    const handler = createAskForApprovalShim({
      service,
      options: ["Allow", "Deny", "Ignore"],
    });
    await handler(makeAskReq());
    // All options are forwarded; the translation
    // rule treats optionIndex 0 as allow, anything
    // else (including 2) as deny.
    expect(calls[0]?.options).toEqual(["Allow", "Deny", "Ignore"]);
  });
});

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

describe("createAskForApprovalShim — prompt rendering", () => {
  it("includes the tool name and a short bash command summary", async () => {
    const { service, calls } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    const handler = createAskForApprovalShim({ service });
    await handler(
      makeAskReq({
        tool: "bash",
        args: { command: "rm -rf /" },
        question: "Are you sure?",
      }),
    );
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt).toContain("Allow bash to");
    expect(prompt).toContain("`rm -rf /`");
    expect(prompt).toContain("Are you sure?");
  });

  it("uses a 'read path' summary for read_file", async () => {
    const { service, calls } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    const handler = createAskForApprovalShim({ service });
    await handler(
      makeAskReq({
        tool: "read_file",
        args: { path: "/etc/passwd" },
        question: "",
      }),
    );
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt).toContain("read `/etc/passwd`");
  });

  it("falls back to JSON.stringify for unknown tool args", async () => {
    const { service, calls } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    const handler = createAskForApprovalShim({ service });
    await handler(
      makeAskReq({
        tool: "custom_tool",
        args: { foo: "bar", n: 42 },
        question: "",
      }),
    );
    const prompt = calls[0]?.prompt ?? "";
    // The JSON dump is truncated but should still
    // include the shape.
    expect(prompt).toContain("custom_tool");
    expect(prompt).toMatch(/foo.*bar/);
  });

  it("honors a custom formatPrompt override", async () => {
    const { service, calls } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    const handler = createAskForApprovalShim({
      service,
      formatPrompt: (req) => `CUSTOM: ${req.tool}`,
    });
    await handler(makeAskReq());
    expect(calls[0]?.prompt).toBe("CUSTOM: bash");
  });
});

// ---------------------------------------------------------------------------
// Answer → AskDecision translation
// ---------------------------------------------------------------------------

describe("createAskForApprovalShim — answer translation", () => {
  it("Yes index → allow", async () => {
    const { service } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    const handler = createAskForApprovalShim({ service });
    const decision = await handler(makeAskReq());
    expect(decision).toEqual({ kind: "allow" });
  });

  it("No index → deny with reason", async () => {
    const { service } = buildFakeService({
      value: "No",
      optionIndex: 1,
      cancelled: false,
    });
    const handler = createAskForApprovalShim({ service });
    const decision = await handler(makeAskReq());
    expect(decision).toEqual({ kind: "deny", reason: "user denied" });
  });

  it("Free-form 'y' → allow", async () => {
    const { service } = buildFakeService({
      value: "y",
      cancelled: false,
    });
    const handler = createAskForApprovalShim({ service });
    const decision = await handler(makeAskReq());
    expect(decision).toEqual({ kind: "allow" });
  });

  it("Free-form 'yes' (any case) → allow", async () => {
    const { service } = buildFakeService({
      value: "YES",
      cancelled: false,
    });
    const handler = createAskForApprovalShim({ service });
    const decision = await handler(makeAskReq());
    expect(decision).toEqual({ kind: "allow" });
  });

  it("Free-form anything else → deny (fail-closed)", async () => {
    const { service } = buildFakeService({
      value: "maybe later",
      cancelled: false,
    });
    const handler = createAskForApprovalShim({ service });
    const decision = await handler(makeAskReq());
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toContain("user denied");
    }
  });

  it("'no-provider' cancellation → deny with reason 'no user channel'", async () => {
    const { service } = buildFakeService({
      value: "",
      cancelled: true,
      cancelledReason: "no-provider",
    });
    const handler = createAskForApprovalShim({ service });
    const decision = await handler(makeAskReq());
    expect(decision).toEqual({ kind: "deny", reason: "no user channel" });
  });

  it("'aborted' cancellation → deny with that reason", async () => {
    const { service } = buildFakeService({
      value: "",
      cancelled: true,
      cancelledReason: "aborted",
    });
    const handler = createAskForApprovalShim({ service });
    const decision = await handler(makeAskReq());
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toBe("user cancelled (aborted)");
    }
  });

  it("'timeout' cancellation → deny with that reason", async () => {
    const { service } = buildFakeService({
      value: "",
      cancelled: true,
      cancelledReason: "timeout",
    });
    const handler = createAskForApprovalShim({ service });
    const decision = await handler(makeAskReq());
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toBe("user cancelled (timeout)");
    }
  });
});

// ---------------------------------------------------------------------------
// Signal forwarding
// ---------------------------------------------------------------------------

describe("createAskForApprovalShim — signal forwarding", () => {
  it("forwards the AskRequest's AbortSignal to the service", async () => {
    const { service, calls } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    const handler = createAskForApprovalShim({ service });
    const ac = new AbortController();
    await handler(makeAskReq({ signal: ac.signal }));
    expect(calls[0]?.signal).toBe(ac.signal);
  });
});
