/**
 * Config layer stack (Codex-style):
 *   config.dist.toml → user config.toml → project .envoy/config.toml → overrides
 *
 * CLI `--config <path>` replaces the user layer when provided.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ConfigLoadError,
  loadConfigFile,
  resolveConfigPath,
} from "./loader.js";
import {
  isProjectTrusted,
  sanitizeProjectLayer,
  trustedProjectsPath,
} from "./project-trust.js";
import type { ConfigLayer } from "./schema.js";
import { ConfigLayerSchema } from "./schema.js";

export interface LoadConfigStackOptions {
  /** Project cwd for `.envoy/config.toml`. */
  cwd?: string;
  /** Explicit user/CLI config path (replaces default user config). */
  filePath?: string;
  /** Highest-precedence overlay (CLI flags as a layer). */
  overrides?: ConfigLayer;
  /**
   * Whether the project-local layer may set security-relevant keys.
   *
   * - `undefined` (default): consult the persisted trust list
   *   (`isProjectTrusted`); untrusted projects get the sanitized layer.
   * - `true`: trust the project (host already verified it).
   * - `false`: always sanitize.
   *
   * See `project-trust.ts` for why this exists.
   */
  trustProject?: boolean;
  /** Override the trust-list path (tests / hosts). */
  trustFilePath?: string;
}

export interface LoadedConfigStack {
  layer: ConfigLayer;
  /** Paths that contributed (existing files only), low → high precedence. */
  sources: ReadonlyArray<string>;
  /**
   * Security-relevant keys stripped from the project-local layer. Empty
   * when there was no project layer, it had none, or it was trusted.
   * Hosts should surface these (see `projectConfigWarning`).
   */
  ignoredProjectKeys: ReadonlyArray<string>;
}

/**
 * Merge config layers. Later layers win on defined keys.
 * Arrays (`hooks`, `mcpServers`, …) are replaced, not concatenated —
 * same semantics as `mergeLayers` in the loader.
 */
export function mergeConfigLayers(
  ...layers: ReadonlyArray<ConfigLayer>
): ConfigLayer {
  let out: ConfigLayer = {};
  for (const layer of layers) {
    out = mergeTwo(out, layer);
  }
  return out;
}

function mergeTwo(a: ConfigLayer, b: ConfigLayer): ConfigLayer {
  const out: ConfigLayer = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v !== undefined) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** Default dist path beside the resolved user config. */
export function defaultDistConfigPath(userConfigPath?: string): string {
  return path.join(
    path.dirname(userConfigPath ?? resolveConfigPath()),
    "config.dist.toml",
  );
}

/**
 * Load and merge the config stack. Missing files are silent.
 */
export async function loadConfigStack(
  options: LoadConfigStackOptions = {},
): Promise<LoadedConfigStack> {
  const sources: string[] = [];
  const layers: ConfigLayer[] = [];
  let ignoredProjectKeys: ReadonlyArray<string> = [];

  const userPath =
    options.filePath !== undefined
      ? path.resolve(options.filePath)
      : resolveConfigPath();

  const distPath = defaultDistConfigPath(userPath);
  const dist = await tryLoad(distPath);
  if (dist !== undefined) {
    layers.push(dist);
    sources.push(distPath);
  }

  const user = await tryLoad(userPath);
  if (user !== undefined) {
    layers.push(user);
    sources.push(userPath);
  }

  if (options.cwd !== undefined) {
    const projectPath = path.join(options.cwd, ".envoy", "config.toml");
    const project = await tryLoad(projectPath);
    if (project !== undefined) {
      // SECURITY: the project layer is repository-controlled input. It
      // is merged ABOVE the user's config, so without this gate a
      // cloned repo could set `permissionPreset = "approve-all"`,
      // register hooks, or spawn MCP servers just by being opened.
      const trusted =
        options.trustProject ??
        (await isProjectTrusted(
          options.cwd,
          options.trustFilePath ?? trustedProjectsPath(),
        ));
      if (trusted) {
        layers.push(project);
      } else {
        const sanitized = sanitizeProjectLayer(project);
        layers.push(sanitized.layer);
        ignoredProjectKeys = sanitized.ignoredKeys;
      }
      sources.push(projectPath);
    }
  }

  if (options.overrides !== undefined) {
    layers.push(options.overrides);
  }

  return {
    layer: mergeConfigLayers(...layers),
    sources,
    ignoredProjectKeys,
  };
}

async function tryLoad(filePath: string): Promise<ConfigLayer | undefined> {
  try {
    await fs.access(filePath);
  } catch {
    return undefined;
  }
  try {
    return await loadConfigFile(filePath);
  } catch (err) {
    if (err instanceof ConfigLoadError) throw err;
    throw new ConfigLoadError(
      err instanceof Error ? err.message : String(err),
      filePath,
    );
  }
}

/** Validate a raw object as ConfigLayer (for tests / overlays). */
export function parseConfigLayer(raw: unknown): ConfigLayer {
  return ConfigLayerSchema.parse(raw);
}

/** Home-relative helper for docs/tests. */
export function userConfigHomeHint(): string {
  return path.join(os.homedir(), ".config", "envoy-harness");
}
