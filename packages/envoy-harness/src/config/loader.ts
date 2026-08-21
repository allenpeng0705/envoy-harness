/**
 * Config loader — reads a TOML file and returns a
 * `ConfigLayer` (validated against `ConfigLayerSchema`).
 *
 * **v0 scope:** the loader reads ONE user-config file
 * (the `--config <path>` value, or the default
 * `~/.config/envoy-harness/config.toml`). The full
 * layer composition from design §20.1 (config.dist.toml
 * → config.toml → .envoy/config.toml → CLI flags) is
 * deferred to a future chunk; the consumer (the CLI
 * runner) is responsible for the CLI-flag step today.
 *
 * **File format:** the file is TOML. The field names
 * in the file are kebab-case (`permission_mode`,
 * `ask_for_approval`, `writable_roots`); the loader
 * maps them to camelCase in the returned object
 * (`permissionMode`, `askForApproval`, `writableRoots`).
 *
 * **Why smol-toml?** The dependency is small (~6 KB
 * minified), zero-runtime-deps, and supports the full
 * TOML spec — so we don't hand-roll a parser and
 * worry about edge cases. The hand-rolled code here
 * is the schema validation + kebab-to-camel mapping,
 * which is the value-add.
 *
 * **Errors:**
 * - File does not exist → returns an empty `{}` (the
 *   user hasn't created a config yet; the agent uses
 *   its built-in defaults). `ENOENT` is the only
 *   silent case.
 * - File exists but is malformed → throws a
 *   `ConfigLoadError` with the smol-toml error
 *   message (includes line + column).
 * - File exists and is well-formed but the shape is
 *   wrong (e.g. `permission_mode = 123`) → throws a
 *   `ConfigLoadError` with the zod issues.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parse as parseToml } from "smol-toml";

import { ConfigLayerSchema, type ConfigLayer } from "./schema.js";

/**
 * The default config file path. Resolved relative to
 * the user's home directory (`~/.config/envoy-harness/config.toml`).
 *
 * **Why this path:** matches the XDG Base Directory
 * spec for user config (`$XDG_CONFIG_HOME` or
 * `~/.config`). The user can override with `--config <path>`
 * or `$ENVOY_HARNESS_CONFIG`.
 */
export const DEFAULT_CONFIG_PATH = path.join(
  ".config",
  "envoy-harness",
  "config.toml",
);

/**
 * A config loader error. The `.cause` holds the
 * underlying parser / validator error.
 */
export class ConfigLoadError extends Error {
  override readonly name = "ConfigLoadError";
  constructor(
    message: string,
    readonly filePath: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Read one config file from disk and return the
 * validated `ConfigLayer`. Returns `{}` if the file
 * does not exist (the common case: fresh install).
 *
 * @param filePath absolute path to the TOML file
 * @throws `ConfigLoadError` if the file is malformed
 *   (smol-toml or zod rejected it)
 */
export async function loadConfigFile(
  filePath: string,
): Promise<ConfigLayer> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new ConfigLoadError(
      `failed to read config file: ${filePath}: ${(err as Error).message}`,
      filePath,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw new ConfigLoadError(
      `failed to parse TOML: ${filePath}: ${(err as Error).message}`,
      filePath,
      err,
    );
  }

  // The TOML file uses kebab-case keys; the type uses
  // camelCase. Map the well-known fields explicitly
  // (cheaper than a recursive key-converter + safer
  // than letting the user bind to either convention).
  const mapped = mapKebabToCamel(parsed) as unknown;

  const result = ConfigLayerSchema.safeParse(mapped);
  if (!result.success) {
    throw new ConfigLoadError(
      `invalid config shape: ${filePath}: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      filePath,
      result.error,
    );
  }
  return result.data;
}

/**
 * Resolve the config file path from a priority list:
 *
 * 1. Explicit `filePath` argument (from `--config <path>`)
 * 2. `$ENVOY_HARNESS_CONFIG` env var
 * 3. `$XDG_CONFIG_HOME/envoy-harness/config.toml` (if XDG is set)
 * 4. `~/.config/envoy-harness/config.toml` (default)
 *
 * Returns the resolved absolute path. The path is
 * returned even if the file doesn't exist (the caller
 * decides whether to throw or default to `{}`).
 */
export function resolveConfigPath(filePath?: string): string {
  if (filePath !== undefined) {
    return path.resolve(filePath);
  }
  const fromEnv = process.env["ENVOY_HARNESS_CONFIG"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return path.resolve(fromEnv);
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") {
    return path.resolve(xdg, "envoy-harness", "config.toml");
  }
  return path.resolve(os.homedir(), DEFAULT_CONFIG_PATH);
}

/**
 * Read the config from the resolved path.
 * Convenience for the CLI runner: `loadConfig({filePath})`
 * is the one-call entrypoint.
 */
export async function loadConfig(
  options: { filePath?: string } = {},
): Promise<{ layer: ConfigLayer; resolvedPath: string }> {
  const resolvedPath = resolveConfigPath(options.filePath);
  const layer = await loadConfigFile(resolvedPath);
  return { layer, resolvedPath };
}

/**
 * Phase B / Item 15.1: load the native config AND an
 * imported config (e.g. a codex `config.toml`) and
 * merge them.
 *
 * **Merge order (later wins):**
 * 1. native `loadConfigFile(path)` — envoy-harness's
 *    own TOML file,
 * 2. imported layer — e.g. codex's `config.toml`,
 * 3. explicit `overrides` (rarely used; the runner
 *    uses the CLI flags directly, not via this helper).
 *
 * **Why imported wins over native:** the user explicitly
 * passed `--import-config <path>` — they want the
 * imported file to take effect. The native file is
 * still loaded (so a user with both files gets the
 * union of both, with imported as the tiebreaker).
 *
 * **CLI flags win over both** — that's enforced by the
 * runner (`parsed.sandbox ?? configLayer.permissionMode
 * ?? "read-only"` in `cli/run/one-shot.ts`). This helper
 * just provides the merge primitive; precedence at the
 * CLI level is the runner's job.
 *
 * **Warnings:** the imported result carries a
 * `warnings[]` list. The runner surfaces a one-line
 * summary; `--verbose` prints the full list.
 *
 * **Hermetic:** no I/O beyond reading the two files.
 */
export async function loadConfigWithImport(options: {
  /** Explicit path to the native config file. `undefined`
   *  → use the default (`~/.config/envoy-harness/config.toml`).
   *  Missing file is silent (matches `loadConfig`). */
  filePath?: string;
  /** Explicit path to the imported config file. Required
   *  when `importFrom` is set. */
  importPath?: string;
  /** The format of the imported file. Required when
   *  `importPath` is set. */
  importFrom?: string;
  /** Optional override layer (merged LAST, wins over both). */
  overrides?: ConfigLayer;
}): Promise<{
  layer: ConfigLayer;
  resolvedPath: string;
  importResult?: {
    layer: ConfigLayer;
    warnings: ReadonlyArray<{ key: string; reason: string }>;
    sourcePath: string;
  };
}> {
  const { layer: native, resolvedPath } = await loadConfig(
    options.filePath !== undefined ? { filePath: options.filePath } : {},
  );
  if (options.importPath === undefined || options.importFrom === undefined) {
    return { layer: options.overrides !== undefined ? mergeLayers(native, options.overrides) : native, resolvedPath };
  }
  // Lazy import: the importer pulls in `smol-toml` (already
  // a transitive dep of the loader) and adds a few KB to
  // the import graph. The lazy import keeps the loader's
  // own import graph small for callers that don't use the
  // import flag.
  const { isImportFormat } = await import("./import/index.js");
  if (!isImportFormat(options.importFrom)) {
    throw new ConfigLoadError(
      `unsupported import format: '${options.importFrom}' ` +
        `(supported: codex, deepseek-cordis). ` +
        `Format auto-detection lands in a future chunk.`,
      options.importPath,
    );
  }
  // Dispatch on format. The lazy import keeps the loader's
  // own import graph small for callers that don't use the
  // import flag.
  const importResult =
    options.importFrom === "codex"
      ? await runCodexImport(options.importPath)
      : await runDeepseekImport(options.importPath);
  const merged = mergeLayers(native, importResult.layer);
  const final =
    options.overrides !== undefined ? mergeLayers(merged, options.overrides) : merged;
  return {
    layer: final,
    resolvedPath,
    importResult: {
      layer: importResult.layer,
      warnings: importResult.warnings,
      sourcePath: importResult.sourcePath,
    },
  };
}

/** Phase B / Item 15.1: dispatch to the codex importer. */
async function runCodexImport(filePath: string): Promise<{
  layer: import("../config/index.js").ConfigLayer;
  warnings: ReadonlyArray<{ key: string; reason: string }>;
  sourcePath: string;
}> {
  const { importCodexConfig } = await import("./import/index.js");
  const r = await importCodexConfig({ filePath });
  return {
    layer: r.layer,
    warnings: r.warnings.map((w) => ({ key: w.key, reason: w.reason })),
    sourcePath: r.sourcePath,
  };
}

/** Phase B / Item 15.2: dispatch to the deepseek importer. */
async function runDeepseekImport(filePath: string): Promise<{
  layer: import("../config/index.js").ConfigLayer;
  warnings: ReadonlyArray<{ key: string; reason: string }>;
  sourcePath: string;
}> {
  const { importDeepseekConfig } = await import("./import/index.js");
  const r = await importDeepseekConfig({ filePath });
  return {
    layer: r.layer,
    warnings: r.warnings.map((w) => ({ key: w.plugin, reason: w.reason })),
    sourcePath: r.sourcePath,
  };
}

/**
 * Merge two `ConfigLayer`s. The second layer wins on
 * conflicting keys (the import helper uses this to make
 * the imported layer override the native one).
 *
 * **Why not Object.assign:** `Object.assign` is fine for
 * a flat object like `ConfigLayer`, but writing the
 * merge as a typed function makes the intent explicit
 * + lets us add per-key coercion later if needed.
 */
function mergeLayers(a: ConfigLayer, b: ConfigLayer): ConfigLayer {
  const out: ConfigLayer = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v !== undefined) {
      // The `as never` cast is because TypeScript can't
      // narrow `b[k]` to the specific ConfigLayer key's
      // type without a switch; the runtime is fine because
      // the importer already validated the layer against
      // ConfigLayerSchema.
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * Map the well-known kebab-case TOML keys to the
 * camelCase TypeScript field names. Unknown keys are
 * passed through (the zod schema strips them with
 * `.optional()`, so they don't leak into the type).
 *
 * **Why only the well-known fields?** The v0
 * `ConfigLayer` has 6 fields. Hand-mapping them is
 * shorter than a recursive camelCase converter and
 * surfaces typos in the user's TOML (an unknown key
 * becomes a zod "unrecognized" issue, not a silent
 * no-op).
 */
function mapKebabToCamel(obj: unknown): Record<string, unknown> {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    switch (k) {
      case "permission_mode":
        out["permissionMode"] = v;
        break;
      case "ask_for_approval":
        out["askForApproval"] = v;
        break;
      case "sandbox_backend":
        out["sandboxBackend"] = v;
        break;
      case "network_access":
        out["networkAccess"] = v;
        break;
      case "slash_tmp_writable":
        out["slashTmpWritable"] = v;
        break;
      case "writable_roots":
        out["writableRoots"] = v;
        break;
      default:
        // Unknown key — let the zod schema decide.
        out[k] = v;
        break;
    }
  }
  return out;
}
