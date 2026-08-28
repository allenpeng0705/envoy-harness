/**
 * Phase B / Item 15.2 — deepseek codec extensions to
 * `runShellHandler`.
 *
 * **What this exercises:** the new exit-2 behavior +
 * `permissionDecision` / `additionalContext` handling in
 * `hookSpecificOutput`. The existing v0 test suite covers
 * the legacy top-level shape (`decision: "block"`, etc.) +
 * plain-stdout fallback; this file adds the deepseek
 * extensions.
 *
 * **Hermetic:** every test uses `echo` to emit the JSON
 * (or non-JSON) stdout. No real hook script needed.
 *
 * **Coverage:**
 * 1. Exit 2 + empty stderr → `block` with default reason.
 * 2. Exit 2 + non-empty stderr → `block` with stderr
 *    as the reason.
 * 3. Exit 0 + `{permissionDecision: "deny"}` → `block`
 *    with the reason.
 * 4. Exit 0 + `{permissionDecision: "allow"}` →
 *    `continue`.
 * 5. Exit 0 + `{permissionDecision: "ask"}` (with a
 *    reason) → `ask` decision with the question.
 * 6. Exit 0 + `{hookSpecificOutput: {additionalContext: "..."}}`
 *    → `add-context` with the content.
 * 7. Exit 0 + structured stdout that names a different
 *    `hookEventName` → event-scoped fields are discarded
 *    (the legacy top-level decision still applies).
 * 8. Exit 0 + legacy top-level `decision: "block"` →
 *    `block` (sanity check that the legacy path still
 *    works).
 */

import { describe, expect, it } from "vitest";

import { runShellHandler } from "../../src/index.js";

// A `spawn` invocation via `sh -c "..."` lets us control
// the exit code + stdout + stderr precisely. Each test
// composes a one-liner that emits the exact JSON we want.

describe("runShellHandler: deepseek codec extensions", () => {
  it("exit 2 with empty stderr → block with default reason", async () => {
    const decision = await runShellHandler(
      "exit 2",
      "PreToolUse",
      { tool: "bash" },
    );
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") {
      expect(decision.reason).toBe("blocked by hook");
    }
  });

  it("exit 2 with non-empty stderr → block with stderr as reason", async () => {
    const decision = await runShellHandler(
      `echo "denied because x" >&2; exit 2`,
      "PreToolUse",
      { tool: "bash" },
    );
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") {
      // The runner trims the trailing newline from
      // stderr (the deepseek codec trims it; the
      // legacy path used `slice(0, MAX_STDERR_REASON)`
      // which kept it — this test pins the new
      // trimmed behavior).
      expect(decision.reason).toBe("denied because x");
    }
  });

  it("permissionDecision 'deny' on a clean exit → block with reason", async () => {
    const decision = await runShellHandler(
      `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"manual review required"}}'`,
      "PreToolUse",
      { tool: "bash" },
    );
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") {
      expect(decision.reason).toBe("manual review required");
    }
  });

  it("permissionDecision 'allow' → continue", async () => {
    const decision = await runShellHandler(
      `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`,
      "PreToolUse",
      { tool: "bash" },
    );
    expect(decision.kind).toBe("continue");
  });

  it("permissionDecision 'ask' → ask decision with the question", async () => {
    const decision = await runShellHandler(
      `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"confirm?"}}'`,
      "PreToolUse",
      { tool: "bash" },
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind === "ask") {
      expect(decision.question).toBe("confirm?");
    }
  });

  it("additionalContext → add-context with the content", async () => {
    const decision = await runShellHandler(
      `echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"audit log checked"}}'`,
      "PostToolUse",
      { tool: "bash" },
    );
    expect(decision.kind).toBe("add-context");
    if (decision.kind === "add-context") {
      expect(decision.content).toBe("audit log checked");
    }
  });

  it("hookSpecificOutput with mismatched hookEventName discards event-scoped fields", async () => {
    // The hook claims `PreToolUse` but the firing event is
    // `PostToolUse`. The deepseek protocol says to discard
    // the event-scoped fields. The legacy top-level
    // `decision: "block"` still applies.
    const decision = await runShellHandler(
      `echo '{"decision":"block","reason":"still blocks","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`,
      "PostToolUse",
      { tool: "bash" },
    );
    // The legacy top-level decision wins; the
    // permissionDecision is discarded (mismatched event).
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") {
      expect(decision.reason).toBe("still blocks");
    }
  });

  it("legacy top-level `decision: 'block'` still works (regression)", async () => {
    const decision = await runShellHandler(
      `echo '{"decision":"block","reason":"legacy path"}'`,
      "PreToolUse",
      { tool: "bash" },
    );
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") {
      expect(decision.reason).toBe("legacy path");
    }
  });
});
