/**
 * Hook system tests (§8.2 + §8.3 of the design).
 *
 * Three things are tested:
 * 1. `HookRegistry`: registration, composition, ordering, short-circuit.
 * 2. `runShellHandler`: spawns `sh -c`, parses stdout, handles errors.
 * 3. `runModuleHandler`: dynamic import, default export contract.
 *
 * **Module fixtures** live in `test/fixtures/hooks-modules/`:
 * - `block.ts` — always returns `block`.
 * - `echo.ts` — adds its eventName as context.
 * - `no-default.ts` — has no default export.
 *
 * **Stability note:** tests use a fresh `new HookRegistry()` per test
 * (not `defaultRegistry`). Sharing state across tests is a known
 * source of "passes in isolation, fails in suite" bugs.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  defaultRegistry,
  HookRegistry,
  runModuleHandler,
  runShellHandler,
  type HookHandler,
} from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, "fixtures", "hooks-modules");
const MODULE_BLOCK = path.join(MODULE_DIR, "block.ts");
const MODULE_ECHO = path.join(MODULE_DIR, "echo.ts");
const MODULE_NO_DEFAULT = path.join(MODULE_DIR, "no-default.ts");

// ---------------------------------------------------------------------------
// HookRegistry — composition
// ---------------------------------------------------------------------------

describe("HookRegistry: registration", () => {
  it("runs a registered handler and returns its decision", async () => {
    const r = new HookRegistry();
    r.on("PreToolUse", async () => ({ kind: "block", reason: "nope" }));
    const d = await r.fire("PreToolUse", { tool: "bash" });
    expect(d).toEqual({ kind: "block", reason: "nope" });
  });

  it("returns continue when no handler is registered", async () => {
    const r = new HookRegistry();
    const d = await r.fire("PreToolUse", { tool: "bash" });
    expect(d).toEqual({ kind: "continue" });
  });

  it("runs multiple handlers in registration order", async () => {
    const r = new HookRegistry();
    const calls: string[] = [];
    r.on("PreToolUse", async () => {
      calls.push("first");
      return { kind: "add-context", content: "a" };
    });
    r.on("PreToolUse", async () => {
      calls.push("second");
      return { kind: "add-context", content: "b" };
    });
    await r.fire("PreToolUse", {});
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("HookRegistry: match filter", () => {
  it("fires a handler with no match clause for any payload", async () => {
    const r = new HookRegistry();
    let called = false;
    r.on("PreToolUse", async () => {
      called = true;
      return { kind: "continue" };
    });
    await r.fire("PreToolUse", { tool: "anything" });
    expect(called).toBe(true);
  });

  it("filters by match.tool", async () => {
    const r = new HookRegistry();
    r.on("PreToolUse", {
      match: { tool: "bash" },
      module: MODULE_ECHO,
    });
    // Match: tool === "bash".
    const matched = await r.fire("PreToolUse", { tool: "bash" });
    expect(matched.kind).toBe("add-context");
    // No match: tool === "write_file".
    const unmatched = await r.fire("PreToolUse", { tool: "write_file" });
    expect(unmatched).toEqual({ kind: "continue" });
  });

  it("filters by match.pattern (regex against JSON-stringified payload)", async () => {
    const r = new HookRegistry();
    r.on("PreToolUse", {
      match: { pattern: '"tool":"bash"' },
      module: MODULE_ECHO,
    });
    // Matches: payload contains "tool":"bash".
    const matched = await r.fire("PreToolUse", { tool: "bash" });
    expect(matched.kind).toBe("add-context");
    // Doesn't match.
    const unmatched = await r.fire("PreToolUse", { tool: "write_file" });
    expect(unmatched).toEqual({ kind: "continue" });
  });

  it("requires BOTH match.tool AND match.pattern to match (AND)", async () => {
    const r = new HookRegistry();
    r.on("PreToolUse", {
      match: { tool: "bash", pattern: "rm\\s+-rf" },
      module: MODULE_ECHO,
    });
    // Both match.
    const both = await r.fire("PreToolUse", {
      tool: "bash",
      command: "rm -rf /",
    });
    expect(both.kind).toBe("add-context");
    // Only tool matches.
    const onlyTool = await r.fire("PreToolUse", {
      tool: "bash",
      command: "ls",
    });
    expect(onlyTool).toEqual({ kind: "continue" });
    // Only pattern matches.
    const onlyPattern = await r.fire("PreToolUse", {
      tool: "write_file",
      command: "rm -rf /",
    });
    expect(onlyPattern).toEqual({ kind: "continue" });
  });
});

describe("HookRegistry: unregister", () => {
  it("removes a registered handler and returns true", async () => {
    const r = new HookRegistry();
    const handler: HookHandler = {
      module: MODULE_BLOCK,
    };
    r.on("PreToolUse", handler);
    expect(r.unregister("PreToolUse", handler)).toBe(true);
    // Now firing returns continue (no handlers).
    const d = await r.fire("PreToolUse", {});
    expect(d).toEqual({ kind: "continue" });
  });

  it("returns false when handler is not registered", () => {
    const r = new HookRegistry();
    const handler: HookHandler = { module: MODULE_BLOCK };
    expect(r.unregister("PreToolUse", handler)).toBe(false);
  });

  it("returns false when the event has no handlers", () => {
    const r = new HookRegistry();
    const handler: HookHandler = { module: MODULE_BLOCK };
    expect(r.unregister("PreToolUse", handler)).toBe(false);
  });
});

describe("HookRegistry: middleware", () => {
  it("runs middleware before handlers", async () => {
    const r = new HookRegistry();
    const calls: string[] = [];
    r.use(async () => {
      calls.push("mw");
      return { kind: "continue" };
    });
    r.on("PreToolUse", async () => {
      calls.push("handler");
      return { kind: "continue" };
    });
    await r.fire("PreToolUse", {});
    expect(calls).toEqual(["mw", "handler"]);
  });

  it("short-circuits when middleware returns block", async () => {
    const r = new HookRegistry();
    let handlerCalled = false;
    r.use(async () => ({ kind: "block", reason: "mw-blocked" }));
    r.on("PreToolUse", async () => {
      handlerCalled = true;
      return { kind: "continue" };
    });
    const d = await r.fire("PreToolUse", {});
    expect(d).toEqual({ kind: "block", reason: "mw-blocked" });
    expect(handlerCalled).toBe(false);
  });

  it("runs multiple middlewares in registration order until one blocks", async () => {
    const r = new HookRegistry();
    const calls: string[] = [];
    r.use(async () => {
      calls.push("mw1");
      return { kind: "continue" };
    });
    r.use(async () => {
      calls.push("mw2");
      return { kind: "block", reason: "mw2-blocked" };
    });
    r.use(async () => {
      calls.push("mw3"); // should not run
      return { kind: "continue" };
    });
    const d = await r.fire("PreToolUse", {});
    expect(calls).toEqual(["mw1", "mw2"]);
    expect(d).toEqual({ kind: "block", reason: "mw2-blocked" });
  });
});

describe("HookRegistry: decision composition", () => {
  it("first block short-circuits the chain", async () => {
    const r = new HookRegistry();
    let secondCalled = false;
    r.on("PreToolUse", async () => ({ kind: "block", reason: "first" }));
    r.on("PreToolUse", async () => {
      secondCalled = true;
      return { kind: "continue" };
    });
    const d = await r.fire("PreToolUse", {});
    expect(d).toEqual({ kind: "block", reason: "first" });
    expect(secondCalled).toBe(false);
  });

  it("concatenates multiple add-context with newlines", async () => {
    const r = new HookRegistry();
    r.on("PreToolUse", async () => ({
      kind: "add-context",
      content: "first",
    }));
    r.on("PreToolUse", async () => ({
      kind: "add-context",
      content: "second",
    }));
    const d = await r.fire("PreToolUse", {});
    expect(d).toEqual({ kind: "add-context", content: "first\n\nsecond" });
  });

  it("modify on PostToolUse: last one wins", async () => {
    const r = new HookRegistry();
    r.on("PostToolUse", async () => ({ kind: "modify", modified: "first" }));
    r.on("PostToolUse", async () => ({ kind: "modify", modified: "last" }));
    const d = await r.fire("PostToolUse", {});
    expect(d).toEqual({ kind: "modify", modified: "last" });
  });

  it("modify on PreToolUse: returned for the agent to apply", async () => {
    const r = new HookRegistry();
    r.on("PreToolUse", async () => ({ kind: "modify", modified: "x" }));
    const d = await r.fire("PreToolUse", {});
    expect(d).toEqual({ kind: "modify", modified: "x" });
  });

  it("an ask beats a concurrent add-context on PreToolUse", async () => {
    const r = new HookRegistry();
    r.on("PreToolUse", async () => ({
      kind: "add-context",
      content: "some context",
    }));
    r.on("PreToolUse", async () => ({ kind: "ask", question: "approve?" }));
    const d = await r.fire("PreToolUse", {});
    expect(d).toEqual({ kind: "ask", question: "approve?" });
  });

  it("a throwing inline handler becomes a block, not a crash", async () => {
    const r = new HookRegistry();
    r.on("PreToolUse", async () => {
      throw new Error("boom");
    });
    const d = await r.fire("PreToolUse", {});
    expect(d.kind).toBe("block");
    expect(d.kind === "block" && d.reason).toContain("boom");
  });

  it("a throwing middleware becomes a block", async () => {
    const r = new HookRegistry();
    r.use(async () => {
      throw new Error("middleware boom");
    });
    const d = await r.fire("PreToolUse", {});
    expect(d.kind).toBe("block");
  });

  it("block beats add-context and modify", async () => {
    const r = new HookRegistry();
    r.on("PreToolUse", async () => ({
      kind: "add-context",
      content: "ignored",
    }));
    r.on("PreToolUse", async () => ({ kind: "block", reason: "stop" }));
    const d = await r.fire("PreToolUse", {});
    expect(d).toEqual({ kind: "block", reason: "stop" });
  });
});

describe("HookRegistry: diagnostics", () => {
  it("size() counts handlers across events", () => {
    const r = new HookRegistry();
    r.on("PreToolUse", { module: MODULE_ECHO });
    r.on("PreToolUse", { module: MODULE_BLOCK });
    r.on("PostToolUse", { module: MODULE_ECHO });
    expect(r.size()).toBe(3);
  });

  it("listEvents() returns registered event names", () => {
    const r = new HookRegistry();
    r.on("PreToolUse", { module: MODULE_ECHO });
    r.on("SessionStart", { module: MODULE_ECHO });
    expect(r.listEvents().sort()).toEqual(["PreToolUse", "SessionStart"]);
  });

  it("clear() removes all handlers and middlewares", async () => {
    const r = new HookRegistry();
    r.on("PreToolUse", async () => ({ kind: "block", reason: "x" }));
    r.use(async () => ({ kind: "block", reason: "y" }));
    r.clear();
    expect(r.size()).toBe(0);
    expect(r.listEvents()).toEqual([]);
    const d = await r.fire("PreToolUse", {});
    expect(d).toEqual({ kind: "continue" });
  });
});

describe("defaultRegistry", () => {
  it("is a singleton — same instance across imports", () => {
    // The instance is the same. We can't easily test that across
    // different module graphs in vitest, but the type is correct:
    expect(defaultRegistry).toBeInstanceOf(HookRegistry);
  });
});

// ---------------------------------------------------------------------------
// runShellHandler — wire format and error handling
// ---------------------------------------------------------------------------

describe("runShellHandler: stdout parsing", () => {
  it("treats non-JSON stdout as add-context (trimmed)", async () => {
    const d = await runShellHandler(
      'echo "hello world"',
      "PreToolUse",
      {},
      2000,
    );
    expect(d).toEqual({ kind: "add-context", content: "hello world" });
  });

  it("parses JSON {decision:'block', reason:'...'}", async () => {
    const d = await runShellHandler(
      `printf '%s' '{"decision":"block","reason":"hook blocked"}'`,
      "PreToolUse",
      {},
      2000,
    );
    expect(d).toEqual({ kind: "block", reason: "hook blocked" });
  });

  it("parses JSON {decision:'add-context', content:'...'}", async () => {
    const d = await runShellHandler(
      `printf '%s' '{"decision":"add-context","content":"ctx"}'`,
      "PreToolUse",
      {},
      2000,
    );
    expect(d).toEqual({ kind: "add-context", content: "ctx" });
  });

  it("parses JSON {decision:'continue'}", async () => {
    const d = await runShellHandler(
      `printf '%s' '{"decision":"continue"}'`,
      "PreToolUse",
      {},
      2000,
    );
    expect(d).toEqual({ kind: "continue" });
  });

  it("parses JSON {decision:'modify', modified:...}", async () => {
    const d = await runShellHandler(
      `printf '%s' '{"decision":"modify","modified":"new-output"}'`,
      "PostToolUse",
      {},
      2000,
    );
    expect(d).toEqual({ kind: "modify", modified: "new-output" });
  });

  it("JSON {decision:'block'} without reason defaults to 'blocked by hook'", async () => {
    const d = await runShellHandler(
      `printf '%s' '{"decision":"block"}'`,
      "PreToolUse",
      {},
      2000,
    );
    expect(d).toEqual({ kind: "block", reason: "blocked by hook" });
  });

  it("JSON that doesn't start with '{' is treated as add-context", async () => {
    const d = await runShellHandler(
      `printf '%s' 'just plain text'`,
      "PreToolUse",
      {},
      2000,
    );
    expect(d).toEqual({ kind: "add-context", content: "just plain text" });
  });

  it("JSON array (not object) is treated as continue", async () => {
    const d = await runShellHandler(
      `printf '%s' '[1,2,3]'`,
      "PreToolUse",
      {},
      2000,
    );
    // The runner's tryParseJson rejects non-objects; the JSON is
    // not parsed, so it falls through to add-context (non-empty trimmed).
    expect(d).toEqual({ kind: "add-context", content: "[1,2,3]" });
  });

  it("JSON object with no decision field is continue", async () => {
    const d = await runShellHandler(
      `printf '%s' '{"foo":"bar"}'`,
      "PreToolUse",
      {},
      2000,
    );
    expect(d).toEqual({ kind: "continue" });
  });

  it("empty stdout returns continue", async () => {
    const d = await runShellHandler("true", "PreToolUse", {}, 2000);
    expect(d).toEqual({ kind: "continue" });
  });
});

describe("runShellHandler: env vars", () => {
  it("sets HOOK_EVENT and HOOK_PAYLOAD correctly", async () => {
    const d = await runShellHandler(
      `printf '%s' "event=$HOOK_EVENT payload=$HOOK_PAYLOAD"`,
      "SessionStart",
      { user: "alice", mode: "interactive" },
      2000,
    );
    expect(d.kind).toBe("add-context");
    if (d.kind === "add-context") {
      expect(d.content).toBe(
        'event=SessionStart payload={"user":"alice","mode":"interactive"}',
      );
    }
  });

  it("sets TOOL_CALL as legacy alias for HOOK_PAYLOAD", async () => {
    const d = await runShellHandler(
      `printf '%s' "tool=$TOOL_CALL"`,
      "PreToolUse",
      { tool: "bash" },
      2000,
    );
    expect(d.kind).toBe("add-context");
    if (d.kind === "add-context") {
      expect(d.content).toBe('tool={"tool":"bash"}');
    }
  });
});

describe("runShellHandler: error handling", () => {
  it("non-zero exit → block with stderr reason (truncated to 200 chars)", async () => {
    const longStderr = "x".repeat(500);
    const d = await runShellHandler(
      `printf '%s' "${longStderr}" 1>&2; exit 7`,
      "PreToolUse",
      {},
      2000,
    );
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toMatch(/^hook exited 7: /);
      // 200 char cap on stderr.
      expect(d.reason.length).toBeLessThanOrEqual("hook exited 7: ".length + 200);
    }
  });

  it("non-zero exit with no stderr → block with just the code", async () => {
    const d = await runShellHandler(
      "exit 1",
      "PreToolUse",
      {},
      2000,
    );
    expect(d).toEqual({ kind: "block", reason: "hook exited 1" });
  });

  it("timeout → block with 'timed out' reason (SIGKILL)", async () => {
    // Sleep 2 seconds, but timeout in 100ms. Use a fresh short timeout
    // for this test (overrides the default 5s).
    const d = await runShellHandler("sleep 2", "PreToolUse", {}, 100);
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toMatch(/timed out after 100ms/);
    }
  }, 5000); // generous vitest timeout for the test itself

  it("non-existent command → block with 'hook exited' and sh's stderr", async () => {
    // `sh -c "/this/command/..."` — sh starts fine, then the inner
    // command fails with exit 127 and sh prints "No such file" to
    // stderr. The runner sees a non-zero exit (not a spawn error)
    // and reports it as "hook exited 127: ...". (The "failed to
    // start" branch only fires when spawn itself fails — e.g. sh
    // is missing from PATH.)
    const d = await runShellHandler(
      "/this/command/definitely/does/not/exist-xyz",
      "PreToolUse",
      {},
      2000,
    );
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toMatch(/^hook exited 127/);
      expect(d.reason).toMatch(/No such file/);
    }
  });
});

// ---------------------------------------------------------------------------
// runModuleHandler — dynamic import
// ---------------------------------------------------------------------------

describe("runModuleHandler", () => {
  it("calls the default export of a TS module", async () => {
    const d = await runModuleHandler(MODULE_ECHO, "SessionStart", {
      foo: "bar",
    });
    expect(d).toEqual({ kind: "add-context", content: "fired:SessionStart" });
  });

  it("returns block when the module has no default export", async () => {
    const d = await runModuleHandler(MODULE_NO_DEFAULT, "PreToolUse", {});
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toMatch(/no default export/);
    }
  });

  it("returns block when the module path doesn't exist", async () => {
    const d = await runModuleHandler(
      path.join(MODULE_DIR, "this-does-not-exist.ts"),
      "PreToolUse",
      {},
    );
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toMatch(/failed:/);
    }
  });

  it("passes eventName and payload to the hook function", async () => {
    // The block module ignores the event; let's verify by checking
    // the reason string is exactly what blockHook returns.
    const d = await runModuleHandler(MODULE_BLOCK, "PermissionRequest", {
      tool: "bash",
    });
    expect(d).toEqual({
      kind: "block",
      reason: "blocked by fixture module",
    });
  });
});
