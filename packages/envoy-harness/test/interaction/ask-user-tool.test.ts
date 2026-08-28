/**
 * Tests for `src/interaction/ask-user-tool.ts` — the
 * model-facing `ask_user` tool.
 *
 * Covers:
 * 1. Free-form single-line answer → `User answered: <value>`.
 * 2. Options-picker answer → `User selected: "no" (option 2)`.
 * 3. Multiline answer → `User answered:\n<value>`.
 * 4. `cancelled: "no-provider"` → benign fall-through
 *    (`isError: false`).
 * 5. `cancelled: "aborted" | "timeout"` → `isError: true`.
 * 6. Service-level `timeoutMs` forwards to the service.
 * 7. `signal` is forwarded (the agent's abort signal).
 * 8. Multiline + options + timeout combined → service
 *    receives the right shape.
 *
 * **Hermetic:** every test uses a fake `UserQuestionService`
 * (no real stdin / network / LLM).
 */

import { describe, expect, it, vi } from "vitest";

import { makeAskUserTool } from "../../src/interaction/ask-user-tool.js";
import type {
  UserQuestionAnswer,
  UserQuestionProvider,
  UserQuestionRequest,
  UserQuestionService,
} from "../../src/interaction/user-questions.js";
import type { ToolContext } from "../../src/tools/types.js";

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
  // Inline the factory so we don't depend on a
  // shared service. The factory is small enough
  // to duplicate here.
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
        if (current === undefined) {
          return { value: "", cancelled: true, cancelledReason: "no-provider" };
        }
        if (req.signal.aborted) {
          return { value: "", cancelled: true, cancelledReason: "aborted" };
        }
        return current.ask(req);
      },
    },
  };
}

/** A minimal `ToolContext` for the tool. */
function makeContext(signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    cwd: "/tmp",
    session: undefined as never,
    abortSignal: signal,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeAskUserTool", () => {
  it("returns 'User answered: <value>' for a free-form single-line answer", async () => {
    const { service, calls } = buildFakeService({
      value: "yes",
      cancelled: false,
    });
    const tool = makeAskUserTool({ service });
    const out = await tool.execute({ prompt: "Continue?" }, makeContext());
    expect(out.content).toBe("User answered: yes");
    expect(out.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("Continue?");
  });

  it("returns 'User selected: \"<value>\" (option N)' for an options-picker answer", async () => {
    const { service, calls } = buildFakeService({
      value: "no",
      optionIndex: 1,
      cancelled: false,
    });
    const tool = makeAskUserTool({ service });
    const out = await tool.execute(
      {
        prompt: "Which one?",
        options: ["yes", "no"],
      },
      makeContext(),
    );
    expect(out.content).toBe('User selected: "no" (option 2)');
    expect(out.isError).toBeUndefined();
    // The service received the options.
    expect(calls[0]?.options).toEqual(["yes", "no"]);
  });

  it("returns 'User answered:\\n<value>' for a multiline answer", async () => {
    const { service } = buildFakeService({
      value: "line 1\nline 2",
      cancelled: false,
    });
    const tool = makeAskUserTool({ service });
    const out = await tool.execute(
      { prompt: "Paste the log", multiline: true },
      makeContext(),
    );
    expect(out.content).toBe("User answered:\nline 1\nline 2");
    expect(out.isError).toBeUndefined();
  });

  it("returns the benign fall-through text for 'no-provider' (no isError)", async () => {
    const { service } = buildFakeService({
      value: "",
      cancelled: true,
      cancelledReason: "no-provider",
    });
    const tool = makeAskUserTool({ service });
    const out = await tool.execute({ prompt: "Pick one" }, makeContext());
    expect(out.content).toBe(
      "no user channel available; please use your default answer",
    );
    // Benign: isError is NOT set.
    expect(out.isError).toBeUndefined();
  });

  it("returns 'ask_user cancelled by user: aborted' with isError for 'aborted'", async () => {
    const { service } = buildFakeService({
      value: "",
      cancelled: true,
      cancelledReason: "aborted",
    });
    const tool = makeAskUserTool({ service });
    const out = await tool.execute({ prompt: "Pick one" }, makeContext());
    expect(out.content).toBe("ask_user cancelled by user: aborted");
    expect(out.isError).toBe(true);
  });

  it("returns 'ask_user cancelled by user: timeout' with isError for 'timeout'", async () => {
    const { service } = buildFakeService({
      value: "",
      cancelled: true,
      cancelledReason: "timeout",
    });
    const tool = makeAskUserTool({ service });
    const out = await tool.execute({ prompt: "Pick one" }, makeContext());
    expect(out.content).toBe("ask_user cancelled by user: timeout");
    expect(out.isError).toBe(true);
  });

  it("forwards the service-level timeoutMs to the service", async () => {
    const { service, calls } = buildFakeService({
      value: "fast",
      cancelled: false,
    });
    const tool = makeAskUserTool({ service });
    await tool.execute(
      { prompt: "Pick one", timeoutMs: 1500 },
      makeContext(),
    );
    expect(calls[0]?.timeoutMs).toBe(1500);
  });

  it("forwards the agent's abort signal to the service", async () => {
    const { service, calls } = buildFakeService({
      value: "x",
      cancelled: false,
    });
    const ac = new AbortController();
    const tool = makeAskUserTool({ service });
    await tool.execute({ prompt: "x" }, makeContext(ac.signal));
    expect(calls[0]?.signal).toBe(ac.signal);
  });

  it("forwards all flags combined: options + multiline + timeoutMs", async () => {
    const { service, calls } = buildFakeService({
      value: "anything",
      cancelled: false,
    });
    const tool = makeAskUserTool({ service });
    await tool.execute(
      {
        prompt: "Paste a diff",
        multiline: true,
        timeoutMs: 5000,
        options: ["a", "b", "c"],
      },
      makeContext(),
    );
    expect(calls[0]).toMatchObject({
      prompt: "Paste a diff",
      multiline: true,
      timeoutMs: 5000,
      options: ["a", "b", "c"],
    });
  });

  it("falls back to JSON-stringify the options when the answer's optionIndex is unknown", async () => {
    // Edge case: the provider returns an `optionIndex`
    // that doesn't match the input options. The tool
    // should still produce a coherent message.
    const { service } = buildFakeService({
      value: "fallback",
      optionIndex: 99, // out of range
      cancelled: false,
    });
    const tool = makeAskUserTool({ service });
    const out = await tool.execute(
      { prompt: "x", options: ["a", "b"] },
      makeContext(),
    );
    // The options array doesn't have an entry at 99,
    // so we fall back to `answer.value`.
    expect(out.content).toBe('User selected: "fallback" (option 100)');
  });
});
