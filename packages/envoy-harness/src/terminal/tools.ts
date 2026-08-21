/**
 * Phase C / Item 9 — model-facing terminal tools.
 */

import { z } from "zod";

import type { Tool, ToolResult } from "../tools/types.js";
import type { TerminalSessionService } from "./types.js";
import { TerminalError } from "./types.js";

const SIGNAL_SCHEMA = z.enum([
  "SIGINT",
  "SIGTERM",
  "SIGKILL",
  "SIGTSTP",
  "SIGHUP",
]);

function errResult(err: unknown): ToolResult {
  if (err instanceof TerminalError) {
    return {
      content: `terminal error (${err.code}): ${err.message}`,
      isError: true,
    };
  }
  return {
    content: err instanceof Error ? err.message : String(err),
    isError: true,
  };
}

/** Build the six terminal tools bound to a session service. */
export function makeTerminalTools(service: TerminalSessionService): Tool[] {
  const terminalOpen: Tool = {
    name: "terminal_open",
    description:
      "Create a persistent, owner-isolated terminal session from a " +
      "registered backend type. Use for shell/REPL state that must " +
      "survive across tool calls.",
    parameters: z.object({
      type: z
        .string()
        .optional()
        .describe('Registered backend type (default "fake")'),
      name: z
        .string()
        .optional()
        .describe('Optional owner-local display name (e.g. "main")'),
      cwd: z
        .string()
        .optional()
        .describe("Initial working directory (defaults to session cwd)"),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const result = await service.spawn(
          ctx.session.id,
          {
            type: args.type ?? "fake",
            ...(args.name !== undefined ? { name: args.name } : {}),
            cwd: args.cwd ?? ctx.cwd,
          },
          ctx.abortSignal,
        );
        return { content: JSON.stringify(result) };
      } catch (err) {
        return errResult(err);
      }
    },
  };

  const terminalSend: Tool = {
    name: "terminal_send",
    description:
      "Send text to a persistent terminal. By default Enter is " +
      "submitted and the call waits for idle/timeout/exit.",
    parameters: z.object({
      sessionId: z
        .string()
        .describe("Terminal session id from terminal_open / terminal_list"),
      text: z.string().describe("UTF-8 text to write to the terminal"),
      submit: z
        .boolean()
        .optional()
        .describe("Submit Enter after text (default true)"),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const operation = service.startSend(ctx.session.id, args.sessionId, {
          text: args.text,
          submit: args.submit ?? true,
          signal: ctx.abortSignal,
        });
        const result = await operation.done;
        if (ctx.abortSignal.aborted) {
          return { content: "terminal send aborted", isError: true };
        }
        return { content: JSON.stringify({ kind: "foreground", ...result }) };
      } catch (err) {
        return errResult(err);
      }
    },
  };

  const terminalRead: Tool = {
    name: "terminal_read",
    description:
      "Read a bounded page of retained output from a persistent " +
      "terminal without sending input.",
    parameters: z.object({
      sessionId: z.string().describe("Terminal session id"),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Newest-relative line offset (default 0)"),
      count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Requested line count (default 500)"),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const result = service.read(ctx.session.id, args.sessionId, {
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.count !== undefined ? { count: args.count } : {}),
        });
        return { content: JSON.stringify(result) };
      } catch (err) {
        return errResult(err);
      }
    },
  };

  const terminalSignal: Tool = {
    name: "terminal_signal",
    description:
      "Send an allowed signal to the current foreground process " +
      "group of a persistent terminal.",
    parameters: z.object({
      sessionId: z.string().describe("Terminal session id"),
      signal: SIGNAL_SCHEMA.describe("POSIX signal to deliver"),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const result = await service.signal(
          ctx.session.id,
          args.sessionId,
          args.signal,
        );
        return { content: JSON.stringify(result) };
      } catch (err) {
        return errResult(err);
      }
    },
  };

  const terminalClose: Tool = {
    name: "terminal_close",
    description:
      "Close one persistent terminal and wait until its process " +
      "tree is gone.",
    parameters: z.object({
      sessionId: z.string().describe("Terminal session id"),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const closed = await service.kill(
          ctx.session.id,
          args.sessionId,
        );
        return {
          content: JSON.stringify({
            sessionId: args.sessionId,
            outcome: closed ? "closed" : "already-closing",
          }),
        };
      } catch (err) {
        return errResult(err);
      }
    },
  };

  const terminalList: Tool = {
    name: "terminal_list",
    description: "List persistent terminal sessions owned by this session.",
    parameters: z.object({}),
    async execute(_args, ctx): Promise<ToolResult> {
      try {
        const list = service.list(ctx.session.id);
        return { content: JSON.stringify({ sessions: list }) };
      } catch (err) {
        return errResult(err);
      }
    },
  };

  return [
    terminalOpen,
    terminalSend,
    terminalRead,
    terminalSignal,
    terminalClose,
    terminalList,
  ];
}

/** Register all terminal tools on a tool registry. */
export function registerTerminalTools(
  tools: { register(tool: Tool): unknown },
  service: TerminalSessionService,
): void {
  for (const tool of makeTerminalTools(service)) {
    tools.register(tool);
  }
}
