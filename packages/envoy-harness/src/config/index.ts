/**
 * Public config API. Re-exports the schema, the loader,
 * and the path resolver so consumers (`Agent`,
 * `run()`, the REPL) can pull from one import path.
 */
export {
  ConfigLayerSchema,
  type ConfigLayer,
} from "./schema.js";
export {
  ConfigLoadError,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  loadConfigFile,
  resolveConfigPath,
} from "./loader.js";
