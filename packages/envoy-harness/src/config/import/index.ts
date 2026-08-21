/**
 * Phase B / Item 15 — config-import public surface.
 *
 * Re-exports the importers. Chunk 15.1 ships the codex
 * importer; chunk 15.2 adds the deepseek `cordis.yml`
 * importer + the Claude Code hooks.json bridge.
 */

export {
  importCodexConfig,
  type CodexImportResult,
  type CodexImportWarning,
  type ImportCodexOptions,
} from "./codex.js";

export {
  importDeepseekConfig,
  type DeepseekImportResult,
  type DeepseekImportWarning,
  type ImportDeepseekOptions,
} from "./deepseek.js";

export {
  parseClaudeCodeHooks,
  type ParseClaudeCodeHooksOptions,
  type ParseClaudeCodeHooksResult,
  type SkippedCcHook,
} from "./claude-code.js";

/**
 * The set of `--from <format>` values supported by
 * `loadConfigWithImport` (in `src/config/loader.ts`).
 *
 * **v0.2:** `codex` and `deepseek-cordis`. Future chunks
 * add `auto` (auto-detect by file content).
 */
export const SUPPORTED_IMPORT_FORMATS = [
  "codex",
  "deepseek-cordis",
] as const;

/** A `--from <format>` value. */
export type ImportFormat = (typeof SUPPORTED_IMPORT_FORMATS)[number];

/**
 * Type-guard: is `s` a supported import format?
 *
 * Used by the CLI runner to validate the `--from` flag
 * before dispatching to the importer.
 */
export function isImportFormat(s: string): s is ImportFormat {
  return (SUPPORTED_IMPORT_FORMATS as ReadonlyArray<string>).includes(s);
}
