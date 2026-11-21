/**
 * Gap 6 / Wave 1 — PTC-shaped `run_code` via `node:vm` + `tools.invoke`.
 *
 * Parallel-safe nested calls overlap up to `maxParallelSubCalls`;
 * exclusive tools (no `isConcurrencySafe`) are barriers. Per-run
 * invoke allowance defaults from timeout (DeepSeek-style total cap).
 * Nested call ids: `<runId>:ptc:<n>`.
 *
 * No filesystem / require / process.
 */

import * as vm from "node:vm";
import { z } from "zod";

import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolRegistry } from "./registry.js";

export interface MakeRunCodeToolOptions {
  tools: ToolRegistry;
  /** Wall-clock timeout for the script (ms). Default 120_000. */
  timeoutMs?: number;
  /**
   * Max tools.invoke calls per script. When omitted, derived as
   * `max(32, floor(timeoutMs / 60000 * maxSubCallsPerMinute))`.
   */
  maxInvokes?: number;
  /** Rate used to derive maxInvokes from timeout. Default 1024. */
  maxSubCallsPerMinute?: number;
  /** Parallel-safe nested invoke pool size. Default 10; `1` = serial. */
  maxParallelSubCalls?: number;
  tryConsumeWorkBudget?: (units?: number) => boolean;
  /** Opaque parent id for nested `:ptc:<n>` ids. Default random. */
  parentCallId?: string;
}

export interface PtcDispatchEntry {
  id: string;
  name: string;
  ok: boolean;
  result: unknown;
}

const RunCodeParams = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      "JavaScript that may call await tools.invoke(name, args). " +
        "Concurrency-safe tools may overlap when awaited together; " +
        "exclusive tools are barriers. No require, process, or filesystem. " +
        "Return a value to surface it.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional wall-clock override for this program (ms)."),
});

function deriveMaxInvokes(
  timeoutMs: number,
  maxSubCallsPerMinute: number,
  explicit?: number,
): number {
  if (explicit !== undefined) return Math.max(1, Math.floor(explicit));
  const fromTimeout = Math.floor((timeoutMs / 60_000) * maxSubCallsPerMinute);
  return Math.max(32, fromTimeout);
}

function bindingSummary(tools: ToolRegistry): string {
  const lines = tools
    .list()
    .filter((t) => t.name !== "run_code")
    .slice(0, 64)
    .map((t) => {
      const safe =
        t.isConcurrencySafe !== undefined ? " [concurrency-safe]" : "";
      return `- ${t.name}${safe}: ${t.description.slice(0, 120)}`;
    });
  if (lines.length === 0) return "(no other tools registered)";
  return lines.join("\n");
}

class InvokePool {
  private active = 0;
  private exclusiveHeld = false;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxParallel: number) {}

  private wake(): void {
    // Snapshot first — a waiter that cannot enter must re-queue without
    // being re-drained in this same wake (that would spin forever).
    const waiting = this.waiters.splice(0);
    for (const next of waiting) next();
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireExclusive();
    try {
      return await fn();
    } finally {
      this.exclusiveHeld = false;
      this.wake();
    }
  }

  async runShared<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireShared();
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.wake();
    }
  }

  private acquireShared(): Promise<void> {
    return new Promise((resolve) => {
      const tryEnter = (): void => {
        if (this.exclusiveHeld || this.active >= this.maxParallel) {
          this.waiters.push(tryEnter);
          return;
        }
        this.active += 1;
        resolve();
      };
      tryEnter();
    });
  }

  private acquireExclusive(): Promise<void> {
    return new Promise((resolve) => {
      const tryEnter = (): void => {
        if (this.exclusiveHeld || this.active > 0) {
          this.waiters.push(tryEnter);
          return;
        }
        this.exclusiveHeld = true;
        resolve();
      };
      tryEnter();
    });
  }
}

export function makeRunCodeTool(options: MakeRunCodeToolOptions): Tool {
  const defaultTimeoutMs = options.timeoutMs ?? 120_000;
  const maxParallel = Math.max(1, options.maxParallelSubCalls ?? 10);
  const maxSubCallsPerMinute = options.maxSubCallsPerMinute ?? 1024;

  const description =
    "Run a sandboxed JavaScript program that can call " +
    "tools.invoke(name, args) against this agent's tools. " +
    `Up to ${maxParallel} concurrency-safe invokes may overlap; ` +
    "exclusive tools are barriers. No require/process/fs. " +
    "Prefer for multi-step tool orchestration inside one model turn (PTC).\n\n" +
    "Available bindings:\n" +
    bindingSummary(options.tools);

  return {
    name: "run_code",
    description,
    parameters: RunCodeParams,
    // Exclusive at the model batch level: owns nested tool work.
    isConcurrencySafe: () => false,
    async execute(args, ctx): Promise<ToolResult> {
      const timeoutMs =
        typeof args.timeoutMs === "number" && args.timeoutMs > 0
          ? Math.min(args.timeoutMs, 600_000)
          : defaultTimeoutMs;
      const maxInvokes = deriveMaxInvokes(
        timeoutMs,
        maxSubCallsPerMinute,
        options.maxInvokes,
      );
      const runId =
        options.parentCallId ??
        `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const invokes: PtcDispatchEntry[] = [];
      let invokeCount = 0;
      const pool = new InvokePool(maxParallel);
      const abort = new AbortController();
      const onAbort = (): void => abort.abort();
      ctx.abortSignal.addEventListener("abort", onAbort, { once: true });

      const invokeOne = async (
        name: string,
        toolArgs: unknown,
      ): Promise<unknown> => {
        if (abort.signal.aborted) {
          throw new Error("run_code aborted");
        }
        if (options.tryConsumeWorkBudget?.(1) === false) {
          throw new Error(
            "work_budget exhausted: no new tool work admitted from run_code",
          );
        }
        invokeCount += 1;
        if (invokeCount > maxInvokes) {
          abort.abort();
          throw new Error(
            `run_code: maxInvokes (${maxInvokes}) exceeded; program terminated`,
          );
        }
        const tool = options.tools.get(name);
        if (tool === undefined) {
          throw new Error(`tools.invoke: unknown tool '${name}'`);
        }
        if (name === "run_code") {
          throw new Error("tools.invoke: nested run_code is not allowed");
        }
        const callId = `${runId}:ptc:${invokeCount}`;
        const parsed = tool.parameters.parse(toolArgs ?? {});
        const toolCtx: ToolContext = {
          cwd: ctx.cwd,
          session: ctx.session,
          abortSignal: abort.signal.aborted
            ? abort.signal
            : AbortSignal.any
              ? AbortSignal.any([ctx.abortSignal, abort.signal])
              : ctx.abortSignal,
          ...(ctx.sandboxPolicy !== undefined
            ? { sandboxPolicy: ctx.sandboxPolicy }
            : {}),
        };
        const result = await tool.execute(parsed, toolCtx);
        const entry: PtcDispatchEntry = {
          id: callId,
          name,
          ok: result.isError !== true,
          result: result.content,
        };
        invokes.push(entry);
        if (result.isError) {
          throw new Error(
            typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content),
          );
        }
        return result.content;
      };

      const invoke = async (
        name: unknown,
        toolArgs: unknown,
      ): Promise<unknown> => {
        if (typeof name !== "string" || name.length === 0) {
          throw new Error("tools.invoke: name must be a non-empty string");
        }
        const tool = options.tools.get(name);
        const concurrencySafe =
          tool?.isConcurrencySafe?.(toolArgs ?? {}) === true;
        if (concurrencySafe && maxParallel > 1) {
          return pool.runShared(() => invokeOne(name, toolArgs));
        }
        return pool.runExclusive(() => invokeOne(name, toolArgs));
      };

      const sandbox = {
        tools: { invoke },
        console: {
          log: (..._a: unknown[]) => undefined,
          warn: (..._a: unknown[]) => undefined,
          error: (..._a: unknown[]) => undefined,
        },
      };

      try {
        const wrapped = `(async () => { ${args.code}\n })()`;
        const script = new vm.Script(wrapped, { filename: "run_code.js" });
        const context = vm.createContext(sandbox, {
          name: "run_code",
          codeGeneration: { strings: false, wasm: false },
        });
        const result = await Promise.race([
          script.runInContext(context, {
            timeout: timeoutMs,
            breakOnSigint: true,
          }) as Promise<unknown>,
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error(`run_code timed out after ${timeoutMs}ms`)),
              timeoutMs + 50,
            );
          }),
        ]);
        return {
          content: JSON.stringify({
            ok: true,
            returnValue: result ?? null,
            invokes,
            runId,
          }),
          meta: {
            ptc: { runId, invokeCount: invokes.length, maxInvokes },
          },
        };
      } catch (err) {
        return {
          content: JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            invokes,
            runId,
          }),
          isError: true,
          meta: {
            ptc: { runId, invokeCount: invokes.length, maxInvokes },
          },
        };
      } finally {
        ctx.abortSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}
