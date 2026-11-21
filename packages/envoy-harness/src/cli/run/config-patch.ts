/**
 * Parse `--config-patch` JSON or TOML fragment into a ConfigLayer.
 */

import { parse as parseToml } from "smol-toml";

import { ConfigLayerSchema, type ConfigLayer } from "../../config/schema.js";
import { CliError } from "./errors.js";
import { EXIT_USAGE } from "./types.js";

export function parseConfigPatchFragment(raw: string): ConfigLayer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CliError("--config-patch requires a non-empty value", EXIT_USAGE);
  }
  let parsed: unknown;
  try {
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      parsed = JSON.parse(trimmed);
    } else {
      parsed = parseToml(trimmed);
    }
  } catch (err) {
    throw new CliError(
      `--config-patch parse error: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_USAGE,
    );
  }
  const result = ConfigLayerSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(
      `--config-patch schema: ${result.error.issues[0]?.message ?? "invalid"}`,
      EXIT_USAGE,
    );
  }
  return result.data;
}
