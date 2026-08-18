/**
 * @envoymesh/envoy-harness — built-in tools.
 *
 * Phase 1 ships two: `read_file` (read a file) and `bash` (run a
 * shell command). The list is intentionally short; the tool
 * registry is the extension surface, and adding a tool is a
 * one-call affair.
 */

export { readFileTool } from "./read-file.js";
export { bashTool } from "./bash.js";

/** All built-in tools, in registration order. */
import { bashTool } from "./bash.js";
import { readFileTool } from "./read-file.js";

export const BUILTIN_TOOLS = [readFileTool, bashTool] as const;
