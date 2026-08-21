/**
 * Public config API. Re-exports the schema, the loader,
 * and the path resolver so consumers (`Agent`,
 * `run()`, the REPL) can pull from one import path.
 */
export {
  ConfigLayerSchema,
  HookHandlerSpecSchema,
  type ConfigLayer,
  type HookHandlerSpec,
} from "./schema.js";
export {
  ConfigLoadError,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  loadConfigFile,
  loadConfigWithImport,
  resolveConfigPath,
} from "./loader.js";

// Phase B / Item 15: external config importers.
// Chunk 15.1 ships the codex importer; chunk 15.2 adds
// the deepseek `cordis.yml` importer + the CC hooks.json
// bridge. The hook-protocol JSON-RPC bridge is folded
// into the existing `runShellHandler` (see
// `src/hooks/runner.ts`).
export {
  importCodexConfig,
  importDeepseekConfig,
  isImportFormat,
  parseClaudeCodeHooks,
  SUPPORTED_IMPORT_FORMATS,
  type CodexImportResult,
  type CodexImportWarning,
  type DeepseekImportResult,
  type DeepseekImportWarning,
  type ImportCodexOptions,
  type ImportDeepseekOptions,
  type ImportFormat,
  type ParseClaudeCodeHooksOptions,
  type ParseClaudeCodeHooksResult,
  type SkippedCcHook,
} from "./import/index.js";
