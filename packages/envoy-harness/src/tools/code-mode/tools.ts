/**
 * code_mode_exec / code_mode_wait — isolated VM cells with deferred namespaces.
 */

import * as vm from "node:vm";
import { z } from "zod";

import type { Tool, ToolContext, ToolResult } from "../types.js";
import type { ToolRegistry } from "../registry.js";
import type { CodeModeGrantStore } from "./grants.js";
import { createInMemoryCodeModeGrantStore } from "./grants.js";
import { getToolExposure } from "../deferred.js";

export type { CodeModeGrantStore };

export interface MakeCodeModeToolsOptions {
  tools: ToolRegistry;
  grants?: CodeModeGrantStore;
  tryConsumeWorkBudget?: (units?: number) => boolean;
  timeoutMs?: number;
  maxInvokes?: number;
}

interface CellResult {
  returnValue: unknown;
  invokes: Array<{ name: string; ok: boolean; result: unknown }>;
}

interface PendingCell {
  promise: Promise<CellResult>;
  startedAt: number;
}

const ExecParams = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      "JavaScript cell. Call await tools.invoke(name, args) for granted " +
        "namespaces only. Optional // @exec:async pragma keeps the cell " +
        "pending until code_mode_wait.",
    ),
  grantNamespaces: z
    .array(z.string())
    .optional()
    .describe("Tool names to grant for this and later cells in-session."),
  timeoutMs: z.number().int().positive().optional(),
});

const WaitParams = z.object({
  cellId: z.string().min(1).describe("Id returned by an async code_mode_exec."),
  timeoutMs: z.number().int().positive().optional(),
});

export function makeCodeModeTools(options: MakeCodeModeToolsOptions): Tool[] {
  const grants = options.grants ?? createInMemoryCodeModeGrantStore();
  const defaultTimeout = options.timeoutMs ?? 30_000;
  const maxInvokes = options.maxInvokes ?? 64;
  const pending = new Map<string, PendingCell>();
  let cellSeq = 0;

  const runCell = async (
    code: string,
    ctx: ToolContext,
    timeoutMs: number,
  ): Promise<CellResult> => {
    const invokes: Array<{ name: string; ok: boolean; result: unknown }> = [];
    let invokeCount = 0;

    const invoke = async (
      name: unknown,
      toolArgs: unknown,
    ): Promise<unknown> => {
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("tools.invoke: name must be a non-empty string");
      }
      const tool = options.tools.get(name);
      if (tool === undefined) {
        throw new Error(`tools.invoke: unknown tool '${name}'`);
      }
      if (getToolExposure(tool) === "deferred" && !grants.has(name)) {
        throw new Error(
          `code_mode: namespace '${name}' not granted; use grantNamespaces or tool_search`,
        );
      }
      if (
        name === "code_mode_exec" ||
        name === "code_mode_wait" ||
        name === "run_code"
      ) {
        throw new Error(
          `tools.invoke: '${name}' is not callable from code_mode`,
        );
      }
      if (options.tryConsumeWorkBudget?.(1) === false) {
        throw new Error("work_budget exhausted");
      }
      invokeCount += 1;
      if (invokeCount > maxInvokes) {
        throw new Error(`code_mode: maxInvokes (${maxInvokes}) exceeded`);
      }
      const parsed = tool.parameters.parse(toolArgs ?? {});
      const toolCtx: ToolContext = {
        cwd: ctx.cwd,
        session: ctx.session,
        abortSignal: ctx.abortSignal,
        ...(ctx.sandboxPolicy !== undefined
          ? { sandboxPolicy: ctx.sandboxPolicy }
          : {}),
      };
      const result = await tool.execute(parsed, toolCtx);
      invokes.push({
        name,
        ok: result.isError !== true,
        result: result.content,
      });
      if (result.isError) {
        throw new Error(
          typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content),
        );
      }
      return result.content;
    };

    const sandbox = {
      tools: { invoke },
      console: {
        log: (..._a: unknown[]) => undefined,
        warn: (..._a: unknown[]) => undefined,
        error: (..._a: unknown[]) => undefined,
      },
    };

    const wrapped = `(async () => { ${code}\n })()`;
    const script = new vm.Script(wrapped, { filename: "code_mode.js" });
    const context = vm.createContext(sandbox, {
      name: "code_mode",
      codeGeneration: { strings: false, wasm: false },
    });
    const value = await Promise.race([
      script.runInContext(context, {
        timeout: timeoutMs,
        breakOnSigint: true,
      }) as Promise<unknown>,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`code_mode timed out after ${timeoutMs}ms`)),
          timeoutMs + 50,
        );
      }),
    ]);
    return { returnValue: value ?? null, invokes };
  };

  const execTool: Tool = {
    name: "code_mode_exec",
    description:
      "Execute a JavaScript cell in an isolated sandbox. Grant deferred " +
      "tool namespaces with grantNamespaces (or prior tool_search). " +
      "Prefix with // @exec:async to return a cellId and finish via code_mode_wait.",
    parameters: ExecParams,
    isConcurrencySafe: () => false,
    async execute(args, ctx): Promise<ToolResult> {
      if (args.grantNamespaces !== undefined) {
        grants.grant(args.grantNamespaces);
      }
      const timeoutMs = args.timeoutMs ?? defaultTimeout;
      const asyncPragma = /^\s*\/\/\s*@exec:async\b/m.test(args.code);
      const cellId = `cell_${++cellSeq}`;
      try {
        if (asyncPragma) {
          const promise = runCell(args.code, ctx, timeoutMs);
          pending.set(cellId, { promise, startedAt: Date.now() });
          return {
            content: JSON.stringify({
              ok: true,
              async: true,
              cellId,
              grants: grants.list(),
            }),
          };
        }
        const out = await runCell(args.code, ctx, timeoutMs);
        return {
          content: JSON.stringify({
            ok: true,
            async: false,
            cellId,
            returnValue: out.returnValue,
            invokes: out.invokes,
            grants: grants.list(),
          }),
        };
      } catch (err) {
        return {
          content: JSON.stringify({
            ok: false,
            cellId,
            error: err instanceof Error ? err.message : String(err),
            grants: grants.list(),
          }),
          isError: true,
        };
      }
    },
  };

  const waitTool: Tool = {
    name: "code_mode_wait",
    description: "Wait for an async code_mode_exec cell to finish.",
    parameters: WaitParams,
    isConcurrencySafe: () => false,
    async execute(args): Promise<ToolResult> {
      const entry = pending.get(args.cellId);
      if (entry === undefined) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `unknown cellId '${args.cellId}'`,
          }),
          isError: true,
        };
      }
      const timeoutMs = args.timeoutMs ?? defaultTimeout;
      try {
        const out = await Promise.race([
          entry.promise,
          new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(`code_mode_wait timed out after ${timeoutMs}ms`),
                ),
              timeoutMs,
            );
          }),
        ]);
        pending.delete(args.cellId);
        return {
          content: JSON.stringify({
            ok: true,
            cellId: args.cellId,
            returnValue: out.returnValue,
            invokes: out.invokes,
          }),
        };
      } catch (err) {
        return {
          content: JSON.stringify({
            ok: false,
            cellId: args.cellId,
            error: err instanceof Error ? err.message : String(err),
          }),
          isError: true,
        };
      }
    },
  };

  return [execTool, waitTool];
}
