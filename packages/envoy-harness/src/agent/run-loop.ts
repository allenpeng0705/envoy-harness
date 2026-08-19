/**
 * The agent's main turn loop, extracted from
 * `agent.ts` in T3.1.
 *
 * **What it does (per design §3.4):**
 * 1. Append the user's prompt to the session
 *    (with the system prompt, if any, as the
 *    first message).
 * 2. Emit `agent_start`.
 * 3. Loop (bounded by `maxIterations`):
 *    a. Call the model.
 *    b. Attribute cost (F7.1).
 *    c. Check the cost cap (F7.5).
 *    d. Emit `model_response`.
 *    e. Append the assistant message.
 *    f. Extract tool calls; if none → return.
 *    g. Run the tool calls through `ToolExecutor`.
 *    h. If the model said `max_tokens` → return.
 * 4. Throw on `maxIterations` exhaustion.
 *
 * **Why a top-level function, not a method:** the
 * loop body is ~180 lines and the only method
 * that needs to be reachable from a "run" handle
 * (a future `ReplAgentHandle`, a CLI subcommand,
 * the test harness). Extracting it makes the
 * Agent class a thin facade (its public API
 * stays the same; `run()` is now a 1-liner
 * delegating to `runAgentLoop`).
 *
 * **Why not a `RunState` class:** the per-`run`
 * state is just `iterations` + the in-flight
 * response + the in-flight content. A class
 * with those 3 fields and a single `run()`
 * method would be 200 lines of boilerplate
 * for no testability win — the loop reads
 * them from the loop-local `let`s and
 * passes them to `agent.makeResult` at the
 * exit. A free function is the right shape
 * ("testability wins on tie").
 *
 * **Pure refactor:** the loop body is moved
 * verbatim. The behavior is identical;
 * `Agent.run(prompt)` still returns the same
 * `AgentResult`.
 */
import type { ContentBlock } from "../tools/index.js";
import type { ModelResponse } from "../model.js";
import type { Agent, AgentResult } from "../agent.js";

/**
 * Run the agent's turn loop. Reads from the
 * agent's public state (model, tools, session,
 * hooks, executor, etc.) and calls back into
 * `agent.emit` and `agent.makeResult` for the
 * trace + result builder.
 *
 * **Why take `agent` as an argument, not a
 * snapshot:** the loop reads live state on every
 * iteration (the REPL can swap the model via
 * `/model`; `/sandbox` mutates the policy; the
 * hooks registry can be replaced). A snapshot
 * would freeze the loop on construction.
 *
 * @param agent the owning Agent (public surface
 *             only; the loop calls `agent.emit`,
 *             `agent.makeResult`, `agent.executor`,
 *             etc.)
 * @param prompt the user's prompt for this turn
 */
export async function runAgentLoop(
  agent: Agent,
  prompt: string,
): Promise<AgentResult> {
  // System prompt goes first (idempotent: skip if a system
  // message is already present).
  if (
    agent.systemPrompt !== undefined &&
    !agent.session.messages.some((m) => m.role === "system")
  ) {
    agent.session.appendMessage("system", [
      { type: "text", text: agent.systemPrompt },
    ]);
  }
  agent.session.appendMessage("user", [{ type: "text", text: prompt }]);

  // F9.4: emit agent_start. The model name is the best
  // guess we have (the agent doesn't know which model
  // the adapter will use until the first call returns
  // `usage.model`; for v0 we read it from the cost
  // tracker after each response — the start event uses
  // a placeholder "unknown" if unset).
  agent.emit({
    kind: "agent_start",
    ts: new Date().toISOString(),
    sessionId: agent.session.id,
    model: agent.costTracker.currentModel,
    cwd: agent.cwd,
    tools: agent.tools.list().map((t) => t.name),
  });

  let iterations = 0;
  while (iterations < agent.maxIterations) {
    if (agent.abortController.signal.aborted) {
      return agent.makeResult([], "aborted", iterations);
    }
    iterations++;

    // 1. Call the model.
    let response: ModelResponse;
    try {
      response = await agent.model.complete({
        messages: agent.session.messages,
        tools: agent.tools.list(),
        signal: agent.abortController.signal,
      });
    } catch (err) {
      // Model errors are surfaced as a synthetic assistant
      // message so the user sees the error in the transcript
      // and the loop exits cleanly (no retry policy in v0).
      const message = (err as Error).message ?? String(err);
      agent.emit({
        kind: "error",
        ts: new Date().toISOString(),
        iteration: iterations,
        message: `model error: ${message}`,
      });
      agent.session.appendMessage("assistant", [
        { type: "text", text: `[model error] ${message}` },
      ]);
      return agent.makeResult(
        [{ type: "text", text: `[model error] ${message}` }],
        "aborted",
        iterations,
      );
    }

    // 1b. F7.1: cost attribution. The model reports usage; the
    // Agent attributes it to the right model (each model has
    // its own price). Unknown model + missing usage = 0 cost
    // (graceful default for FakeModel / local).
    if (response.usage) {
      agent.costTracker.addUsage(
        {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        },
        response.model,
      );
    }

    // 1c. F7.5: cost cap. After every usage attribution, check
    // against the cap. The cap is checked DURING the run, not
    // at the end — that's the whole point of a cap. Abort
    // cleanly; the result still has the cost up to this point.
    if (agent.maxCostUsd !== undefined) {
      const total = agent.costTracker.total();
      if (total.costUsd > agent.maxCostUsd) {
        const reason = `max-cost-usd exceeded: $${total.costUsd.toFixed(4)} > $${agent.maxCostUsd}`;
        agent.abortController.abort(reason);
        // Surface the abort reason in the transcript AND the
        // result content so the model/user sees why the run
        // stopped (v0 omitted this — the user saw a silent
        // "aborted" stop reason with the last response text).
        const note: ContentBlock = {
          type: "text",
          text: `\n\n[aborted] ${reason}`,
        };
        agent.session.appendMessage("assistant", [note]);
        return agent.makeResult(
          [...response.content, note],
          "aborted",
          iterations,
        );
      }
    }

    // F9.4: emit model_response (after cost attribution
    // so the event matches what the agent saw).
    agent.emit({
      kind: "model_response",
      ts: new Date().toISOString(),
      iteration: iterations,
      stopReason: response.stopReason,
      content: response.content,
      ...(response.usage ? { usage: response.usage } : {}),
    });

    // 2. Append the assistant message.
    agent.session.appendMessage("assistant", response.content);

    // 3. Extract tool calls.
    const toolCalls = response.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_call" }> =>
        b.type === "tool_call",
    );

    // 4. No tool calls → done.
    if (toolCalls.length === 0) {
      return agent.makeResult(
        response.content,
        normalizeStopReason(response.stopReason),
        iterations,
      );
    }

    // 5. Execute the tool calls. F10.2: when
    // ALL the calls are `task` (sub-agents),
    // run them in parallel — each sub-agent
    // gets its own session with no shared
    // state, so there's nothing to order by.
    // Mixed iterations (some `task` + some
    // `bash`) stay serial (bash is
    // order-dependent). The model's pattern
    // is the driver; the host doesn't opt in.
    await agent.executor.executeMany(toolCalls, iterations);

    // If model said "max_tokens" and we have tool calls, treat
    // as end-of-turn; the agent shouldn't loop on a truncated
    // response. The transcript still has the tool results, so
    // a follow-up `run()` would see them.
    if (response.stopReason === "max_tokens") {
      return agent.makeResult(response.content, "max_tokens", iterations);
    }
  }

  throw new Error(
    `agent loop exceeded max iterations (${agent.maxIterations})`,
  );
}

/**
 * Normalize the model's `stopReason` into our
 * `AgentResult` union. `tool_use` from the model
 * means "I want to call a tool"; we keep that
 * semantic so callers can distinguish "I just
 * want to call one tool" from "I'm done talking".
 *
 * v0 is a no-op (the model's stopReason is already
 * a valid `AgentResult["stopReason"]`). The
 * indirection is here so a future normalization
 * (e.g. mapping `stop_sequence` to a richer set)
 * has a single chokepoint.
 */
function normalizeStopReason(
  modelReason: ModelResponse["stopReason"],
): AgentResult["stopReason"] {
  return modelReason;
}
