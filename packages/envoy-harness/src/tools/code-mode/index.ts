/**
 * Wave 1 — Codex-shaped code_mode surface over isolated node:vm.
 *
 * `code_mode_exec` runs a cell; optional namespaces are granted via
 * `grantNamespaces` or prior `tool_search` grants. `code_mode_wait`
 * joins an async cell by id (cells that return a Promise without await).
 */

export {
  makeCodeModeTools,
  type CodeModeGrantStore,
  type MakeCodeModeToolsOptions,
} from "./tools.js";
export { createInMemoryCodeModeGrantStore } from "./grants.js";
