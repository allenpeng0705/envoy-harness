/**
 * Phase B / Item 3.2 — built-in sample plugin: `confirm-tool`.
 *
 * **What this is:** a hook plugin that asks the user
 * to confirm every invocation of a particular tool
 * (default: `bash`). The plugin registers a
 * `PreToolUse` handler that returns
 * `{ kind: "ask", ... }` when the payload's `tool`
 * field matches the configured target; otherwise
 * the handler returns `{ kind: "continue" }` (a
 * pass-through).
 *
 * **Why this plugin:** it exercises three facets of
 * the seam that the `audit-log` sample doesn't:
 *
 * 1. **A `PreToolUse` hook** (the `audit-log` is
 *    `PostToolUse`). Proves the seam works for any
 *    of the 12 hook events.
 * 2. **The `ask` decision** (F9.1's
 *    `AskDecision` host wire). The agent loop
 *    pauses, calls `AgentOptions.askHandler`,
 *    and resumes with the user's allow / deny /
 *    modify choice. The `audit-log` plugin never
 *    returns `ask`.
 * 3. **Config-driven behavior** (`config.tool`).
 *    The plugin's `apply(ctx, config)` reads the
 *    config and behaves differently based on it.
 *
 * **Manual filter (not `match.tool`):** the
 * `HookRegistry.on()` API takes
 * `HookFn | HookHandler` (see `src/types.ts:212`);
 * the declarative `HookHandler.match` field is
 * only honored for shell-command / TS-module
 * handlers, NOT for inline `HookFn` calls. A
 * `HookFn` that wants to filter by tool name
 * must inspect the payload itself. This plugin
 * does the canonical "filter, then act" pattern.
 *
 * **Hermetic:** no I/O, no LLM, no real kernel.
 * The test suite fires synthetic `PreToolUse`
 * events on a real `HookRegistry` and asserts
 * the returned `HookDecision`.
 *
 * **Config shape:** `{ tool?: string }` — the tool
 * name to ask on. v0 accepts `unknown` (chunk 3.4
 * adds a zod schema). The plugin reads
 * `config?.tool ?? "bash"` and falls back to
 * `"bash"` when the field is absent.
 */

import { z } from "zod";

import type { HookDecision, HookEvent } from "../../types.js";
import type { CapabilityModule, Disposable } from "../types.js";

/** The confirm-tool plugin's typed config. The
 *  `| undefined` is intentional: the zod schema's
 *  optional fields produce `{ key: string | undefined }`
 *  in the parsed output, and the interface matches
 *  that exactOptionalPropertyTypes-friendly shape. */
export interface ConfirmToolConfig {
  /** The tool name to ask on. Default: `"bash"`. */
  tool?: string | undefined;
}

/** zod schema for the confirm-tool plugin's config.
 *  Chunk 3.4: the runner validates the CLI-supplied
 *  config against this schema before calling `apply`. */
export const ConfirmToolConfigSchema = z.object({
  tool: z.string().optional(),
});

/** The plugin's name. Used by the whitelist + the registry. */
export const CONFIRM_TOOL_NAME = "envoy-harness-plugin-confirm-tool";

/**
 * The confirm-tool plugin.
 *
 * Registers a `PreToolUse` handler that:
 * - filters by `payload.tool === targetTool`
 *   (default `bash`, override via `config.tool`);
 * - returns `ask` for matching tool calls (so the
 *   host's `askHandler` prompts the user);
 * - returns `continue` for non-matching calls.
 *
 * The `ask` decision surfaces the tool name + a
 * standard question + the standard "Allow / Deny"
 * options, which is the canonical "permission
 * request" shape in codex / claudecode / deepseek.
 *
 * The returned `Disposable` unregisters the
 * handler when the plugin is disposed.
 */
export const confirmToolPlugin: CapabilityModule<ConfirmToolConfig> = {
  name: CONFIRM_TOOL_NAME,
  configSchema: ConfirmToolConfigSchema,

  apply(ctx, config): Disposable {
    const { tool: targetTool = "bash" } = config;
    const handler = async (event: HookEvent): Promise<HookDecision> => {
      // Manual filter: the `HookFn` shape doesn't
      // accept a `match` clause (that's only on the
      // declarative `HookHandler` form). We inspect
      // the payload ourselves.
      const payload = event.payload as { tool?: string };
      if (payload.tool !== targetTool) {
        return { kind: "continue" };
      }
      // Matched: ask the user. The question +
      // options follow the F9.1 `ask` shape. The
      // host (Tauri / web / REPL) renders these
      // through its own UI; the v0 runner's
      // `defaultAskHandler` logs + denies.
      return {
        kind: "ask",
        question: `Allow ${targetTool} to run with these args?`,
        options: [
          { id: "allow", label: "Allow" },
          { id: "deny", label: "Deny" },
        ],
      };
    };
    ctx.hooks.on("PreToolUse", handler);
    return () => {
      ctx.hooks.unregister("PreToolUse", handler);
    };
  },
};
