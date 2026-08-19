/**
 * F10.3.1 tests — `SubagentResultSigner` seam + `LocalMeshSubmitter.signer` option.
 *
 * Covers:
 * 1. LocalMeshSubmitter with no signer → empty signature
 *    (backward compat with F10.1.2's v0 default).
 * 2. LocalMeshSubmitter with a fake signer → signature equals
 *    `signer(result)`, non-empty.
 * 3. The signer is called once per submit (not zero, not twice).
 * 4. The signer receives the full `SubagentResult` (status,
 *    content, verdict, cost, duration, workerPeerId) — the host
 *    decides what to sign, but envoy-harness hands over everything.
 * 5. Multiple sub-agents each get signed (2 sub-agents → signer
 *    called twice; the two results carry distinct signatures
 *    because their content / durationMs differ).
 * 6. The signature field is the ONLY field the signer changes;
 *    every other field on `SubagentResult` is the same.
 * 7. End-to-end: a parent that runs the `task` tool against a
 *    `LocalMeshSubmitter` with a signer sees the signed result
 *    in the parent's `tool_result` block.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  LocalMeshSubmitter,
  ToolRegistry,
  defaultBuildSubagentFactory,
  newSessionId,
  type ModelAdapter,
  type ModelResponse,
  type SubagentResult,
  type SubagentResultSigner,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function textModel(responses: ReadonlyArray<{ content: ModelResponse["content"] }>): ModelAdapter {
  let idx = 0;
  return {
    async complete() {
      const r = responses[idx++];
      if (!r) throw new Error("textModel: scripted responses exhausted");
      return {
        content: r.content,
        stopReason: r.content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn",
      };
    },
  };
}

function textBlock(text: string): ModelResponse["content"][number] {
  return { type: "text", text };
}

function buildParentAgent(model: ModelAdapter): { agent: Agent; session: InMemorySession; tools: ToolRegistry } {
  const tools = new ToolRegistry();
  const session = new InMemorySession(newSessionId(), {
    cwd: "/",
    permissionMode: "read-only",
    startedAt: new Date().toISOString(),
  });
  const agent = new Agent({
    model,
    tools,
    session,
    hooks: new HookRegistry(),
    cwd: "/",
  });
  return { agent, session, tools };
}

/**
 * Build a scriptable model for the SUB-AGENT. The parent uses
 * `parentModel`; the sub-agent uses `subModel`. They are separate
 * so the parent's iteration count doesn't accidentally consume
 * the sub-agent's scripted responses.
 */
function subModelWithResponse(response: { content: ModelResponse["content"] }): ModelAdapter {
  return textModel([response]);
}

// ---------------------------------------------------------------------------
// 1. No signer → empty signature (backward compat)
// ---------------------------------------------------------------------------

describe("F10.3.1: SubagentResultSigner seam", () => {
  it("no signer → empty signature (F10.1.2 v0 default)", async () => {
    const subModel = subModelWithResponse({ content: [textBlock("done")] });
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({ model: subModel }),
      workerPeerId: "w1",
      // No signer.
    });
    const result = await submitter.submit(
      {
        objective: "x",
        capabilityTag: "code-search",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    expect(result.signature).toBe("");
    // Other fields are unaffected.
    expect(result.status).toBe("completed");
    expect(result.workerPeerId).toBe("w1");
  });
});

// ---------------------------------------------------------------------------
// 2. Signer provided → signature equals signer(result)
// ---------------------------------------------------------------------------

describe("F10.3.1: LocalMeshSubmitter.signer option", () => {
  it("signer is called; signature equals signer(result)", async () => {
    const subModel = subModelWithResponse({ content: [textBlock("done")] });
    const signerCalls: SubagentResult[] = [];
    const signer: SubagentResultSigner = (result) => {
      signerCalls.push({ ...result });
      return "sig-" + result.content.map((b) => (b.type === "text" ? b.text : "")).join("|");
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({ model: subModel }),
      workerPeerId: "w1",
      signer,
    });
    const result = await submitter.submit(
      {
        objective: "x",
        capabilityTag: "code-search",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    expect(result.signature).toBe("sig-done");
    expect(signerCalls).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // 3. Signer called once per submit
  // -----------------------------------------------------------------------

  it("signer is called exactly once per submit (not zero, not twice)", async () => {
    const subModel = subModelWithResponse({ content: [textBlock("a")] });
    let callCount = 0;
    const signer: SubagentResultSigner = () => {
      callCount++;
      return "sig-" + callCount;
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({ model: subModel }),
      workerPeerId: "w1",
      signer,
    });
    await submitter.submit(
      {
        objective: "x",
        capabilityTag: "code-search",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    expect(callCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 4. Signer receives the full SubagentResult
  // -----------------------------------------------------------------------

  it("signer receives the full SubagentResult (status, content, verdict, cost, duration, workerPeerId)", async () => {
    const subModel = subModelWithResponse({ content: [textBlock("hello")] });
    let received: SubagentResult | undefined;
    const signer: SubagentResultSigner = (r) => {
      received = { ...r };
      return "sig";
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({ model: subModel }),
      workerPeerId: "peer-42",
      signer,
    });
    await submitter.submit(
      {
        objective: "x",
        capabilityTag: "code-search",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    expect(received).toBeDefined();
    expect(received?.status).toBe("completed");
    expect(received?.content).toHaveLength(1);
    expect((received?.content[0] as { type: "text"; text: string }).text).toBe("hello");
    expect(received?.verdict).toEqual({ kind: "pass", score: 0.5, confidence: "medium" });
    expect(received?.workerPeerId).toBe("peer-42");
    expect(received?.workerRuntime).toBe("envoy-harness");
    expect(typeof received?.costUsd).toBe("number");
    expect(typeof received?.durationMs).toBe("number");
    // The signature field is empty at the time the signer is called
    // (we're computing it). The signer can include it or not — host
    // decides. envoy-harness just hands over the base result.
    expect(received?.signature).toBe("");
  });

  // -----------------------------------------------------------------------
  // 5. Multiple sub-agents each get signed; distinct signatures
  // -----------------------------------------------------------------------

  it("two sub-agents in a row → signer called twice, distinct signatures", async () => {
    const subModel = textModel([
      { content: [textBlock("first")] },
      { content: [textBlock("second")] },
    ]);
    const seen: string[] = [];
    const signer: SubagentResultSigner = (r) => {
      const sig = "sig-" + (r.content[0] as { type: "text"; text: string }).text;
      seen.push(sig);
      return sig;
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({ model: subModel }),
      workerPeerId: "w1",
      signer,
    });
    const r1 = await submitter.submit(
      {
        objective: "a",
        capabilityTag: "x",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    const r2 = await submitter.submit(
      {
        objective: "b",
        capabilityTag: "x",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    expect(seen).toEqual(["sig-first", "sig-second"]);
    expect(r1.signature).toBe("sig-first");
    expect(r2.signature).toBe("sig-second");
  });

  // -----------------------------------------------------------------------
  // 6. Signature is the ONLY field the signer changes
  // -----------------------------------------------------------------------

  it("signing only changes the signature field; everything else is identical", async () => {
    // Two scripted responses: one for each submitter's call.
    // (F10.2.1 self-review lesson: shared scripted model + two
    // callers = second caller sees "responses exhausted" abort.)
    const subModel = textModel([
      { content: [textBlock("done")] },
      { content: [textBlock("done")] },
    ]);
    // Run twice: once without signer, once with a signer that returns
    // a fixed string. Every field except signature should be the same.
    const submitterUnsigned = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({ model: subModel }),
      workerPeerId: "w1",
    });
    const submitterSigned = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({ model: subModel }),
      workerPeerId: "w1",
      signer: () => "FIXED-SIG",
    });
    const rUnsigned = await submitterUnsigned.submit(
      {
        objective: "x",
        capabilityTag: "code-search",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    const rSigned = await submitterSigned.submit(
      {
        objective: "x",
        capabilityTag: "code-search",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    // Everything except signature and durationMs (which is wall-clock)
    // should match.
    expect(rSigned.signature).toBe("FIXED-SIG");
    expect(rUnsigned.signature).toBe("");
    expect(rSigned.status).toBe(rUnsigned.status);
    expect(rSigned.content).toEqual(rUnsigned.content);
    expect(rSigned.verdict).toEqual(rUnsigned.verdict);
    expect(rSigned.workerPeerId).toBe(rUnsigned.workerPeerId);
    expect(rSigned.workerRuntime).toBe(rUnsigned.workerRuntime);
    expect(rSigned.costUsd).toBe(rUnsigned.costUsd);
  });

  // -----------------------------------------------------------------------
  // 7. End-to-end: parent's tool_result carries the signed SubagentResult
  // -----------------------------------------------------------------------

  it("end-to-end: parent's tool_result carries the signed SubagentResult", async () => {
    // The parent emits a `task` call; the sub-agent returns text;
    // the parent's `tool_result` block has the SubagentResult.
    // We verify the signature is in the parent's transcript.
    const parentModel: ModelAdapter = {
      async complete() {
        return {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "task",
              args: {
                objective: "do x",
                capability_tag: "code-search",
                cost_ceiling_usd: 0.1,
                deadline_ms: 1000,
              },
            },
          ],
          stopReason: "tool_use",
        };
      },
    };
    // The parent's second model call (after the tool result).
    // Use a sequence: first call → tool_use, second call → end_turn.
    let parentCallCount = 0;
    const parentModelSeq: ModelAdapter = {
      async complete() {
        parentCallCount++;
        if (parentCallCount === 1) {
          return {
            content: [
              {
                type: "tool_call",
                id: "t1",
                name: "task",
                args: {
                  objective: "do x",
                  capability_tag: "code-search",
                  cost_ceiling_usd: 0.1,
                  deadline_ms: 1000,
                },
              },
            ],
            stopReason: "tool_use",
          };
        }
        return { content: [textBlock("done")], stopReason: "end_turn" };
      },
    };
    const subModel = subModelWithResponse({ content: [textBlock("sub result")] });
    const signer: SubagentResultSigner = (r) =>
      "SIG-" + (r.content[0] as { type: "text"; text: string }).text;
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({ model: subModel }),
      workerPeerId: "w1",
      signer,
    });
    const { agent, session } = buildParentAgent(parentModelSeq);
    agent.abort; // touch the property to silence unused
    void parentModel;
    // Wire the submitter.
    const tools = new ToolRegistry();
    // Re-create the agent with the submitter so the `task` tool
    // is registered.
    const session2 = new InMemorySession(newSessionId(), {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const parent = new Agent({
      model: parentModelSeq,
      tools,
      session: session2,
      hooks: new HookRegistry(),
      cwd: "/",
      meshSubmitter: submitter,
    });
    const result = await parent.run("go");
    expect(result.stopReason).toBe("end_turn");
    // Find the tool_result in the parent's transcript.
    const toolMessages = session2.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    const toolResult = toolMessages[0]?.content[0] as {
      type: "tool_result";
      toolCallId: string;
      content: { signature?: string; status?: string };
      isError: boolean;
    };
    expect(toolResult.toolCallId).toBe("t1");
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content.signature).toBe("SIG-sub result");
    expect(toolResult.content.status).toBe("completed");
    void session;
  });
});
