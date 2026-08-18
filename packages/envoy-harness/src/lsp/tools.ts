/**
 * LSP tools — 4 tools that wrap the `LspManager`.
 *
 * **Design doc:** `docs/design.md` §22 (F9.2 Phase 4 feature).
 *
 * **What this module is:** the tool surface for the LSP
 * integration. The 4 tools (`lsp_definition`,
 * `lsp_references`, `lsp_hover`, `lsp_diagnostics`) are
 * registered with the `ToolRegistry` only when the host
 * provides an `LspManager` (via `AgentOptions.lspManager`).
 * No manager → no tools (the model's tool list doesn't
 * mention LSP at all).
 *
 * **Line / column convention:** LSP is 0-indexed; the
 * model sees 0-indexed in the tool args. Tool descriptions
 * say "0-indexed" explicitly so the model doesn't
 * subtract 1.
 *
 * **Error handling:** all 4 tools catch errors from the
 * `LspClient` (server crash, timeout) and return
 * `{ content: { error: "..." }, isError: true }`. The
 * model can recover. "No client for this file" returns
 * the same shape (not a throw) so the model can route
 * around it.
 *
 * **Stability:** the 4 tools are the public surface.
 * Additive; new fields on the params / content are
 * additive. Removing a tool is a major version.
 */

import { z } from "zod";

import type { LspManager } from "./types.js";
import type { Tool } from "../tools/types.js";

/** Parameters shared by all 3 "position-based" tools. */
const positionParams = z.object({
  file: z.string().describe(
    "Absolute path to the file. The tool looks up the LSP " +
      "client for this file's language; if no client is " +
      "configured, the tool returns an error.",
  ),
  line: z
    .number()
    .int()
    .nonnegative()
    .describe("0-indexed line number (LSP convention)."),
  column: z
    .number()
    .int()
    .nonnegative()
    .describe("0-indexed column number (LSP convention)."),
});

/** Parameters for `lsp_diagnostics` (file-only, no position). */
const fileParams = z.object({
  file: z.string().describe(
    "Absolute path to the file. Returns the current " +
      "diagnostics that the language server has published " +
      "for this file.",
  ),
});

/** The 4 LSP tools, in registration order. */
export function makeLspTools(manager: LspManager): Tool[] {
  return [
    {
      name: "lsp_definition",
      description:
        "Find the definition(s) of the symbol at the given " +
        "position. Returns a list of file:line:column locations " +
        "(0-indexed). Useful for 'go to definition' and for " +
        "understanding where a symbol is declared.",
      parameters: positionParams,
      async execute({ file, line, column }, _ctx) {
        const client = manager.forFile(file);
        if (!client) {
          return {
            content: { error: "no LSP client for this file" },
            isError: true,
          };
        }
        try {
          const locations = await client.definition(file, line, column);
          return { content: { locations } };
        } catch (e) {
          return {
            content: { error: (e as Error).message },
            isError: true,
          };
        }
      },
    },
    {
      name: "lsp_references",
      description:
        "Find all references (including the declaration) of the " +
        "symbol at the given position. Returns a list of " +
        "file:line:column locations (0-indexed). Useful for " +
        "'find usages' before refactoring.",
      parameters: positionParams,
      async execute({ file, line, column }, _ctx) {
        const client = manager.forFile(file);
        if (!client) {
          return {
            content: { error: "no LSP client for this file" },
            isError: true,
          };
        }
        try {
          const locations = await client.references(file, line, column);
          return { content: { locations } };
        } catch (e) {
          return {
            content: { error: (e as Error).message },
            isError: true,
          };
        }
      },
    },
    {
      name: "lsp_hover",
      description:
        "Get hover information (the symbol's type, signature, " +
        "and docs) at the given position. Returns the contents " +
        "as a string (markdown or plain text). Useful for " +
        "understanding what a symbol is without leaving the file.",
      parameters: positionParams,
      async execute({ file, line, column }, _ctx) {
        const client = manager.forFile(file);
        if (!client) {
          return {
            content: { error: "no LSP client for this file" },
            isError: true,
          };
        }
        try {
          const hover = await client.hover(file, line, column);
          if (hover === null) {
            return { content: { hover: null } };
          }
          return { content: { hover } };
        } catch (e) {
          return {
            content: { error: (e as Error).message },
            isError: true,
          };
        }
      },
    },
    {
      name: "lsp_diagnostics",
      description:
        "Get the current diagnostics (errors, warnings, hints) " +
        "for a file. The language server publishes these as the " +
        "file is edited. Useful for catching type errors and " +
        "lint issues before reading the full file.",
      parameters: fileParams,
      async execute({ file }, _ctx) {
        const client = manager.forFile(file);
        if (!client) {
          return {
            content: { error: "no LSP client for this file" },
            isError: true,
          };
        }
        try {
          const diagnostics = await client.diagnostics(file);
          return { content: { diagnostics } };
        } catch (e) {
          return {
            content: { error: (e as Error).message },
            isError: true,
          };
        }
      },
    },
  ];
}
