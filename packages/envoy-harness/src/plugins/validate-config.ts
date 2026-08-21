/**
 * Phase B / Item 3.4 — per-plugin config validator.
 *
 * **What this is:** the small helper that runs a
 * plugin's `configSchema` (a zod schema) against
 * the parsed config object. Throws `PluginConfigError`
 * on a validation failure. The runner calls this
 * before `register(module, config, ctx)` so the
 * plugin's `apply` always gets a valid `Config`.
 *
 * **Why a separate module, not inline in `one-shot.ts`:** the
 * validation is the same logic every plugin needs
 * (the `configSchema` is optional, but when present
 * the runner MUST validate). A dedicated module
 * keeps the runner's plugin loop readable and gives
 * the validator its own test file.
 *
 * **Why fail-fast in the runner, not lazily in the
 * plugin:** the plugin's `apply` is supposed to
 * TRUST its config. Validation in the runner
 * surfaces a bad config before any plugin touches
 * the agent's `HookRegistry` / `ToolRegistry` (a
 * half-applied plugin set is worse than no plugin
 * set at all).
 */

import type { z } from "zod";
import type { CapabilityModule } from "./types.js";
import { PluginConfigError } from "./types.js";

/**
 * A structural zod-issue shape. We don't reach into
 * zod's internal type names (`$ZodIssue` in v4,
 * `ZodIssue` in v3) so this module works across
 * the zod minor versions the harness pulls in. The
 * `message` + `path` are the only fields the error
 * formatter needs; everything else is forwarded
 * as opaque metadata (callers can introspect for
 * IDE integrations).
 */
export interface ZodIssueLike {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
  readonly code?: string;
  readonly [key: string]: unknown;
}

/**
 * Validate a plugin's config against its
 * `configSchema` (when set). Returns the validated
 * config (the zod `safeParse` result, which is
 * typed against the schema). Throws
 * `PluginConfigError` on a failure.
 *
 * **No-schema case:** when the module has no
 * `configSchema` field, the config passes through
 * unchanged (the v0 contract; the plugin validates
 * internally if it wants to).
 */
export function validatePluginConfig<Config>(
  module: CapabilityModule<Config>,
  config: unknown,
): Config {
  if (module.configSchema === undefined) {
    // No schema → pass through. Cast: the v0
    // contract is `unknown`; the plugin is
    // responsible for internal validation when
    // it doesn't declare a schema.
    return config as Config;
  }
  // `safeParse` returns `{ success, data }` or
  // `{ success: false, error: ZodError }`. We use
  // the safe variant so we can format the error
  // into our own `PluginConfigError`.
  const schema = module.configSchema as z.ZodType<Config>;
  const result = schema.safeParse(config);
  if (!result.success) {
    // `result.error.issues` is zod's issue array.
    // The shape is stable across zod minor versions
    // (`{ path, message, code, ... }`); we cast
    // to our structural type.
    const issues = result.error.issues as unknown as ReadonlyArray<ZodIssueLike>;
    throw new PluginConfigError(module.name, issues);
  }
  return result.data;
}
