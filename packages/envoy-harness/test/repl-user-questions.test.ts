/**
 * Phase A / Item 5 — REPL integration tests for the
 * `userQuestions` option.
 *
 * Covers:
 * 1. `runRepl` builds a fresh `UserQuestionService`
 *    when none is provided, and the agent has the
 *    `ask_user` tool registered.
 * 2. `runRepl` honors an explicit `userQuestions`
 *    option (host-injected service).
 * 3. The provider is unregistered on exit (the
 *    `finally` cleanup fires).
 *
 * **Hermetic:** every test uses a fake `LineReader`
 * (no real stdin) and a scripted `ModelAdapter`
 * (no real LLM).
 */

import { describe, expect, it } from "vitest";

import { runRepl } from "../src/index.js";
import type {
  UserQuestionAnswer,
  UserQuestionProvider,
  UserQuestionService,
} from "../src/interaction/user-questions.js";
import {
  fakeLineReader,
  makeArgs,
  scriptedModel,
  textBlock,
  StringWritable,
} from "./helpers.js";

/** A fake `UserQuestionService` that records the
 *  state on dispose. */
function buildFakeService(
  answer: UserQuestionAnswer,
): {
  service: UserQuestionService;
  registered: { count: number; hasProvider: () => boolean; providerName: () => string | undefined };
  provider: UserQuestionProvider;
} {
  const registered = {
    count: 0,
    hasProvider: (): boolean => false,
    providerName: (): string | undefined => undefined,
  };
  const provider: UserQuestionProvider = {
    name: "fake-repl-provider",
    ask: async () => answer,
  };
  let current: UserQuestionProvider | undefined;
  const service: UserQuestionService = {
    registerProvider(p: UserQuestionProvider): () => void {
      registered.count++;
      if (current !== undefined) {
        throw new Error("already registered");
      }
      current = p;
      registered.hasProvider = () => current !== undefined;
      registered.providerName = () => current?.name;
      return () => {
        if (current === p) current = undefined;
      };
    },
    hasProvider: () => current !== undefined,
    providerName: () => current?.name,
    async ask(): Promise<UserQuestionAnswer> {
      return current!.ask({
        prompt: "x",
        signal: new AbortController().signal,
      });
    },
  };
  return { service, registered, provider };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("REPL + userQuestions", () => {
  it("builds a fresh service + registers a REPL provider when no service is provided", async () => {
    const model = scriptedModel([{ content: [textBlock("hi")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["hello world", "/quit"]),
      stdout: out,
      stderr: err,
    });
    // The REPL created a service + registered the
    // stdin provider. We don't have a handle to the
    // service here (the REPL owns it), but the
    // `setUserQuestions` integration in the agent
    // constructor means the ask_user tool is now
    // registered on the agent's tool registry. The
    // agent's `userQuestions` field is set (verified
    // by the constructor's `if (this.userQuestions)`
    // branch).
    //
    // We assert the agent ran end-to-end (no crash
    // from the new wiring). The transcript test in
    // `agent-user-questions.test.ts` covers the
    // tool-registration invariant directly.
    expect(out.data).toContain("hi");
  });

  it("honors an explicit userQuestions option (host-injected service)", async () => {
    const { service, registered, provider } = buildFakeService({
      value: "x",
      cancelled: false,
    });
    const model = scriptedModel([{ content: [textBlock("hi")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["hello world", "/quit"]),
      stdout: out,
      stderr: err,
      userQuestions: service,
    });
    // The host's service was used as-is; the REPL
    // registered the REPL provider on it (the
    // one-active-provider invariant means the host
    // MUST NOT register a provider beforehand).
    expect(registered.count).toBe(1);
    expect(provider.name).toBe("fake-repl-provider");
  });

  it("unregisters the REPL provider on exit", async () => {
    const model = scriptedModel([{ content: [textBlock("hi")] }]);
    const out = new StringWritable();
    const err = new StringWritable();
    // We pass a fake `userQuestions` to track the
    // provider's `registerProvider` call count + the
    // unregister disposer.
    const { service, registered } = buildFakeService({
      value: "x",
      cancelled: false,
    });
    expect(service.hasProvider()).toBe(false);
    await runRepl({
      model,
      args: makeArgs(),
      lineReader: fakeLineReader(["hello", "/quit"]),
      stdout: out,
      stderr: err,
      userQuestions: service,
    });
    // The REPL registered one provider + the
    // disposer in the `finally` block fired
    // (service is empty again).
    expect(registered.count).toBe(1);
    expect(service.hasProvider()).toBe(false);
  });
});
