/**
 * Phase B / Item 3.4 — `validatePluginConfig` tests.
 *
 * **Hermetic:** the validator is a pure function
 * of (module, config) → config. No I/O, no LLM,
 * no real plugin loading.
 *
 * **Coverage:**
 * 1. A module WITHOUT a `configSchema` → config
 *    passes through unchanged (no validation, no
 *    error).
 * 2. A module WITH a `configSchema` and a valid
 *    config → the validated value is returned.
 * 3. A module WITH a `configSchema` and an
 *    invalid config → throws `PluginConfigError`
 *    with the zod issue in the message.
 * 4. The `PluginConfigError` includes the plugin
 *    name + the issue path + the issue message
 *    (so the user can see exactly which field
 *    was wrong).
 * 5. The `PluginConfigError.issues` field exposes
 *    the structured form for programmatic
 *    introspection.
 * 6. A built-in plugin (audit-log / confirm-tool /
 *    calculator) can be validated via the
 *    exported schema.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AuditLogConfigSchema,
  CalculatorConfigSchema,
  ConfirmToolConfigSchema,
  PluginConfigError,
  auditLogPlugin,
  calculatorPlugin,
  confirmToolPlugin,
  validatePluginConfig,
  type CapabilityModule,
} from "../../src/index.js";

describe("validatePluginConfig: no schema", () => {
  it("passes the config through unchanged when the module has no schema", () => {
    const module: CapabilityModule = {
      name: "no-schema",
      apply: () => undefined,
    };
    const result = validatePluginConfig(module, { anything: 42 });
    expect(result).toEqual({ anything: 42 });
  });
});

describe("validatePluginConfig: with schema", () => {
  const schemaModule: CapabilityModule<{ count: number }> = {
    name: "schema-module",
    configSchema: z.object({ count: z.number().int() }),
    apply: () => undefined,
  };

  it("returns the validated value for a valid config", () => {
    const result = validatePluginConfig(schemaModule, { count: 5 });
    expect(result).toEqual({ count: 5 });
  });

  it("throws PluginConfigError for an invalid config", () => {
    expect(() => validatePluginConfig(schemaModule, { count: "not a number" })).toThrow(
      PluginConfigError,
    );
    expect(() => validatePluginConfig(schemaModule, { count: "not a number" })).toThrow(
      /schema-module/,
    );
    expect(() => validatePluginConfig(schemaModule, { count: "not a number" })).toThrow(
      /count/,
    );
  });

  it("the PluginConfigError includes the plugin name + the issue path + the issue message", () => {
    try {
      validatePluginConfig(schemaModule, { count: "nope" });
      throw new Error("expected validatePluginConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginConfigError);
      const pce = err as PluginConfigError;
      expect(pce.pluginName).toBe("schema-module");
      expect(pce.issues).toHaveLength(1);
      expect(pce.issues[0]?.path).toContain("count");
      expect(pce.issues[0]?.message).toMatch(/number/);
    }
  });
});

describe("validatePluginConfig: built-in plugins", () => {
  it("accepts the audit-log default config (empty object)", () => {
    const result = validatePluginConfig(auditLogPlugin, {});
    expect(result).toEqual({});
  });

  it("accepts the audit-log config with a custom prefix", () => {
    const result = validatePluginConfig(auditLogPlugin, { prefix: "my-app" });
    expect(result).toEqual({ prefix: "my-app" });
  });

  it("rejects the audit-log config with a non-string prefix", () => {
    expect(() => validatePluginConfig(auditLogPlugin, { prefix: 42 })).toThrow(
      PluginConfigError,
    );
    expect(() => validatePluginConfig(auditLogPlugin, { prefix: 42 })).toThrow(
      /Expected string/,
    );
  });

  it("accepts the confirm-tool default config (empty object)", () => {
    const result = validatePluginConfig(confirmToolPlugin, {});
    expect(result).toEqual({});
  });

  it("rejects the confirm-tool config with a non-string tool", () => {
    expect(() => validatePluginConfig(confirmToolPlugin, { tool: 42 })).toThrow(
      PluginConfigError,
    );
    expect(() => validatePluginConfig(confirmToolPlugin, { tool: 42 })).toThrow(
      /Expected string/,
    );
  });

  it("accepts the calculator config with a valid precision", () => {
    const result = validatePluginConfig(calculatorPlugin, { precision: 6 });
    expect(result).toEqual({ precision: 6 });
  });

  it("rejects the calculator config with a negative precision", () => {
    expect(() => validatePluginConfig(calculatorPlugin, { precision: -1 })).toThrow(
      PluginConfigError,
    );
    expect(() => validatePluginConfig(calculatorPlugin, { precision: -1 })).toThrow(
      /precision/,
    );
  });

  it("rejects the calculator config with a non-integer precision", () => {
    expect(() =>
      validatePluginConfig(calculatorPlugin, { precision: 1.5 }),
    ).toThrow(PluginConfigError);
  });
});

describe("zod schemas: standalone", () => {
  it("AuditLogConfigSchema accepts empty input", () => {
    expect(AuditLogConfigSchema.parse({})).toEqual({});
  });

  it("ConfirmToolConfigSchema accepts empty input", () => {
    expect(ConfirmToolConfigSchema.parse({})).toEqual({});
  });

  it("CalculatorConfigSchema rejects precision > 15", () => {
    expect(() => CalculatorConfigSchema.parse({ precision: 16 })).toThrow();
  });
});
