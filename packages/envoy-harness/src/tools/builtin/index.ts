/**
 * @envoymesh/envoy-harness — built-in tools.
 *
 * Phase 1 shipped two: `read_file` and `bash`.
 * T3.5 added `write` (file write), `edit` (targeted
 * edits), and `git` (read-only git operations).
 * Mutating git ops stay in `bash` (the 6 bash
 * validators enforce the same policy).
 */

export { readFileTool } from "./read-file.js";
export { bashTool, makeBashTool, type MakeBashToolOptions } from "./bash.js";
export { writeTool } from "./write.js";
export { editTool } from "./edit.js";
export { gitTool } from "./git.js";
export { applyPatchTool } from "./apply-patch.js";
export {
  makeGlobTool,
  makeGrepTool,
  makeSpillReadTool,
  type MakeGlobGrepToolsOptions,
} from "./glob-grep.js";

/** All built-in tools, in registration order. */
import { applyPatchTool } from "./apply-patch.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { gitTool } from "./git.js";
import { makeGlobTool, makeGrepTool } from "./glob-grep.js";
import { readFileTool } from "./read-file.js";
import { writeTool } from "./write.js";

export const BUILTIN_TOOLS = [
  readFileTool,
  bashTool,
  writeTool,
  editTool,
  applyPatchTool,
  gitTool,
  makeGlobTool(),
  makeGrepTool(),
] as const;
