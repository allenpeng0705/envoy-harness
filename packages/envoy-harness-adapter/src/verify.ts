/**
 * F8.6+ — wire the local verifier rules to the adapter.
 *
 * The adapter's `verify()` was a first-cut deterministic
 * placeholder (non-empty + non-echo). This module wires
 * the real local verifier rules (F1.4d's
 * `runVerifierRules`) so the orchestrator gets the
 * full 6-rule verdict set on every result.
 *
 * **Wire ↔ local round-trip:**
 * - Wire `SignedAgentResult` → local `AgentResult`:
 *   decode content blocks (text + structured tool_call/
 *   result) into the local shape; synthesize a message
 *   list from the content; default the sandbox policy
 *   to a safe `read-only` policy (the wire doesn't carry
 *   it — it's internal audit only).
 * - Local `Verdict[]` → wire `Verdict[]`: a structural
 *   no-op (the two schemas are intentionally aligned).
 *
 * **Why a separate module, not in adapter.ts:** the
 * adapter stays focused on the MAP contract; the
 * verify logic is self-contained and easy to test
 * in isolation. Future chunks can extend the
 * default rule set or add cross-agent verification
 * without touching the adapter.
 *
 * **Why a default `read-only` sandbox policy:** the
 * wire format doesn't carry the worker's effective
 * sandbox (it's internal audit). The verifier's
 * `sandboxRespectedRule` is a no-op when the policy
 * is `read-only` (no paths to check); the rest of the
 * rules run normally. If the orchestrator needs the
 * full audit, the `raw` field on the wire result
 * carries the lossless local result.
 *
 * **Stability:** the public surface is `runLocalVerifier`
 * + the type re-exports. Additive.
 */

import {
  DEFAULT_RULES,
  runVerifierRules,
  type AgentResult as LocalAgentResult,
  type ContentBlock as LocalContentBlock,
  type Message as LocalMessage,
  type VerifierRule,
  type Verdict as LocalVerdict,
} from "@envoymesh/envoy-harness";
import type {
  Verdict as WireVerdict,
  AgentResult as WireAgentResult,
  ContentBlock as WireContentBlock,
  SignedAgentResult,
} from "@envoymesh/protocol";
import type { VerifyInput } from "@envoymesh/agent-adapter";

import {
  TOOL_CALL_SCHEMA_REF,
  TOOL_RESULT_SCHEMA_REF,
  type ToolCallData,
  type ToolResultData,
} from "./translation.js";

// ---------------------------------------------------------------------------
// wire → local (AgentResult shape for the verifier)
// ---------------------------------------------------------------------------

/**
 * Decode a wire `ContentBlock` back to a local
 * `ContentBlock`. The reverse of `localToWireBlock` —
 * tool calls and tool results are decoded from the
 * stable `schemaRef` to the local shape.
 *
 * Returns `undefined` for unrecognized wire shapes
 * (e.g. file, image, structured with a different
 * schemaRef). The caller drops undefineds.
 */
function wireToLocalBlock(block: WireContentBlock): LocalContentBlock | undefined {
  if (block.kind === "text") {
    return { type: "text", text: block.text };
  }
  if (block.kind === "structured") {
    if (block.schemaRef === TOOL_CALL_SCHEMA_REF) {
      const data = block.data as ToolCallData;
      return {
        type: "tool_call",
        id: data.id,
        name: data.name,
        args: data.args,
      };
    }
    if (block.schemaRef === TOOL_RESULT_SCHEMA_REF) {
      const data = block.data as ToolResultData;
      return {
        type: "tool_result",
        toolCallId: data.toolCallId,
        content: data.content,
        isError: data.isError,
      };
    }
  }
  // file, image, structured-with-other-schemaRef: not
  // representable in the local shape. Drop.
  return undefined;
}

/**
 * Map a wire `AgentResult` to a local `AgentResult`
 * shape, suitable for the local verifier. The wire
 * is the *public contract*; the local shape is
 * *runtime-internal*. The verifier expects the local
 * shape; the orchestrator hands the adapter the
 * wire shape; this function bridges.
 *
 * **What the wire doesn't carry (synthesized here):**
 * - `messages`: synthesized from the content (a
 *   single assistant message with all the content
 *   blocks). The full transcript lives in `raw`.
 * - `sandboxPolicy`: default to `read-only` (safe;
 *   the verifier's sandbox rule is a no-op).
 * - `iterations`, `toolCalls`: 0 (unknown to the wire).
 * - `stopReason`: `"end_turn"` (the wire has no
 *   equivalent — the verifier doesn't care).
 */
function wireToLocalAgentResult(wire: WireAgentResult): LocalAgentResult {
  const content: LocalContentBlock[] = [];
  for (const b of wire.content) {
    const local = wireToLocalBlock(b);
    if (local) content.push(local);
  }
  const messages: LocalMessage[] = [
    { role: "assistant", content },
  ];
  return {
    content,
    messages,
    sandboxPolicy: {
      mode: "read-only",
      approval: "on-request",
      backend: "linux-landlock",
      writableRoots: [],
      networkAccess: false,
      excludeSlashTmp: true,
    },
    metrics: {
      inputTokens: wire.metrics.promptTokens ?? 0,
      outputTokens: wire.metrics.completionTokens ?? 0,
      costUsd: wire.metrics.costUsd,
    },
    iterations: 0,
    toolCalls: 0,
    stopReason: "end_turn",
  };
}

// ---------------------------------------------------------------------------
// local → wire (Verdict) — structural no-op but typed
// ---------------------------------------------------------------------------

/**
 * The local and wire `Verdict` schemas are intentionally
 * aligned (per the design §4.3 — Verdict is part of the
 * cross-mesh contract). This function is a typed no-op
 * for forward-compat: if a future chunk adds wire-only
 * verdict variants, the translation lives here.
 */
function localVerdictToWire(v: LocalVerdict): WireVerdict {
  return v as WireVerdict;
}

// ---------------------------------------------------------------------------
// runLocalVerifier
// ---------------------------------------------------------------------------

/**
 * Run the local verifier rules against a wire
 * `SignedAgentResult`. Returns the wire-format verdicts.
 *
 * **Default rules:** `DEFAULT_RULES` (the 6 rules from
 * F1.4d: non-empty-content, output-matches-objective,
 * mesh-task-shape, sandbox-respected, approval-respected,
 * cost-reasonable-for-work). Pass a custom list via
 * the `rules` option.
 *
 * **The objective** comes from `VerifyInput.objective`
 * (the orchestrator's mandate).
 */
export async function runLocalVerifier(
  input: VerifyInput,
  options: {
    rules?: ReadonlyArray<VerifierRule>;
  } = {},
): Promise<WireVerdict[]> {
  const local = wireToLocalAgentResult(input.result as SignedAgentResult);
  const localVerdicts = await runVerifierRules(
    local,
    input.objective,
    options.rules ?? DEFAULT_RULES,
  );
  return localVerdicts.map(localVerdictToWire);
}

/**
 * The reverse direction: take a local `AgentResult` and
 * run the local verifier directly. Useful for the
 * adapter's own self-tests and for callers that have
 * a local result (e.g. the adapter's own `execute()`)
 * and want a verdict before signing.
 *
 * (Currently exported for tests; future chunk may
 * surface this in the public API.)
 */
export async function runLocalVerifierOnLocal(
  result: LocalAgentResult,
  objective: string,
  options: {
    rules?: ReadonlyArray<VerifierRule>;
  } = {},
): Promise<LocalVerdict[]> {
  return runVerifierRules(result, objective, options.rules ?? DEFAULT_RULES);
}
