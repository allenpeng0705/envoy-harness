/**
 * Phase B / Item 3.1 — plugin loader.
 *
 * **What this is:** a one-shot factory that takes a
 * module path, validates it against the whitelist,
 * dynamically imports the module, validates the default
 * export against `CapabilityModule`, and returns the
 * module + a `Disposable`.
 *
 * **Why dynamic `import()`:** the module path is
 * host-supplied (from `--plugin <module>` on the CLI,
 * or from `cordis.yml` in a future chunk). Static
 * imports are resolved at compile time and don't
 * support user-supplied paths.
 *
 * **Why a whitelist:** `await import(modulePath)` is a
 * code-execution vector. A whitelist is the security
 * boundary. The user controls the whitelist (via the
 * built-in list + future opt-in paths).
 *
 * **Why a factory, not a static constructor:** the
 * loader is the one-shot factory; the `PluginRegistry`
 * is the long-lived store. The factory validates the
 * module shape + the whitelist match; the registry
 * owns the lifecycle (apply + dispose).
 */

import {
  PluginLoadError,
  type CapabilityModule,
} from "./types.js";
import {
  isBuiltinPlugin,
  isWhitelistedPlugin,
} from "./whitelist.js";

/** The result of `loadPlugin`. The caller registers
 *  `(module, config)` on a `PluginRegistry`; the
 *  registry calls `module.apply(ctx, config)` once. */
export interface LoadedPlugin<Config = unknown> {
  /** The validated plugin module. */
  module: CapabilityModule<Config>;
  /** The module path the plugin was loaded from (for diagnostics). */
  modulePath: string;
}

/** Options for `loadPlugin`. */
export interface LoadPluginOptions {
  /** The module path to import. The path MUST be in the
   *  whitelist (see `whitelist.ts`); an unwhitelisted
   *  path throws `PluginLoadError`. */
  modulePath: string;
}

/**
 * Load a plugin from the given module path.
 *
 * **Hermetic:** the only I/O is the dynamic import of
 * the module. No network, no file system (the path is
 * resolved by Node's module loader).
 *
 * **Errors:**
 * - Module path not in the whitelist → `PluginLoadError`.
 * - Module has no default export → `PluginLoadError`.
 * - Default export is missing `name` or `apply` →
 *   `PluginLoadError` (with the specific field name).
 * - The module itself throws on load → `PluginLoadError`
 *   (the underlying error becomes `cause`).
 *
 * **Why no `apply` call here:** the loader is the
 * one-shot factory. The caller (the `PluginRegistry`)
 * calls `apply` with the agent's `CapabilityContext` —
 * NOT a synthetic one. The loader is module-loading,
 * not lifecycle.
 */
export async function loadPlugin<Config = unknown>(
  options: LoadPluginOptions,
): Promise<LoadedPlugin<Config>> {
  const { modulePath } = options;
  if (!isWhitelistedPlugin(modulePath)) {
    throw new PluginLoadError(
      `plugin not in whitelist: ${modulePath} ` +
        `(add it to src/plugins/whitelist.ts to load)`,
      modulePath,
    );
  }
  // Built-in samples ship INSIDE this package
  // (src/plugins/builtin/*.ts). The dynamic
  // `import(modulePath)` would fail because the
  // built-in names aren't valid module specifiers
  // (no `node_modules/envoy-harness-plugin-*`).
  // The `BUILTIN_PLUGINS` map in `whitelist.ts`
  // short-circuits the import for the built-in
  // names; the dynamic import is only used for
  // external (non-built-in) plugins.
  if (isBuiltinPlugin(modulePath)) {
    // The built-in map is populated at module load
    // time; the plugin module is a direct reference
    // (validated when it was added to the map).
    // Cast: built-in plugins are typed against
    // `unknown` config (chunk 3.4 adds the typed
    // path via zod schemas).
    const { getBuiltinPlugin } = await import("./whitelist.js");
    const builtIn = getBuiltinPlugin(modulePath);
    if (builtIn === undefined) {
      // Defensive: `isBuiltinPlugin` returned true
      // but the map lookup missed. This would be a
      // bug in `whitelist.ts` (inconsistent state).
      throw new PluginLoadError(
        `internal: built-in plugin '${modulePath}' is in the index but not in the map`,
        modulePath,
      );
    }
    return {
      module: builtIn as unknown as CapabilityModule<Config>,
      modulePath,
    };
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(modulePath)) as Record<string, unknown>;
  } catch (err) {
    throw new PluginLoadError(
      `failed to import plugin module: ${modulePath}: ${(err as Error).message}`,
      modulePath,
      err as Error,
    );
  }
  const def = mod["default"];
  if (def === undefined || def === null) {
    throw new PluginLoadError(
      `plugin module has no default export: ${modulePath}`,
      modulePath,
    );
  }
  const module = validateModule(def, modulePath);
  return { module: module as unknown as CapabilityModule<Config>, modulePath };
}

/**
 * Validate that `value` matches the `CapabilityModule`
 * contract. Throws `PluginLoadError` with a specific
 * reason on the first failure.
 */
function validateModule(
  value: unknown,
  modulePath: string,
): CapabilityModule {
  if (typeof value !== "object" || value === null) {
    throw new PluginLoadError(
      `plugin default export is not an object: ${modulePath}`,
      modulePath,
    );
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj["name"] !== "string" || obj["name"].length === 0) {
    throw new PluginLoadError(
      `plugin default export is missing 'name' (must be a non-empty string): ${modulePath}`,
      modulePath,
    );
  }
  if (typeof obj["apply"] !== "function") {
    throw new PluginLoadError(
      `plugin default export is missing 'apply' (must be a function): ${modulePath}`,
      modulePath,
    );
  }
  return obj as unknown as CapabilityModule;
}
