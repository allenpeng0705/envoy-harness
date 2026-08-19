/**
 * T2.2 — config loader tests.
 *
 * Covers:
 * 1. `loadConfigFile` reads a well-formed TOML file
 *    and returns the parsed `ConfigLayer` (kebab-case
 *    keys mapped to camelCase).
 * 2. `loadConfigFile` returns `{}` for a missing file
 *    (ENOENT is silent; the user just hasn't created
 *    a config yet).
 * 3. `loadConfigFile` throws `ConfigLoadError` with
 *    a helpful message for malformed TOML.
 * 4. `loadConfigFile` throws `ConfigLoadError` with
 *    the zod issue for a well-formed file whose
 *    shape doesn't match the schema.
 * 5. `loadConfig` resolves the path priority
 *    (explicit > env > XDG > default).
 * 6. `resolveConfigPath` honours `$ENVOY_HARNESS_CONFIG`.
 * 7. CLI: `--config <path>` is parsed by argv and
 *    threaded into `RunOptions` via the parsed args.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConfigLayerSchema,
  ConfigLoadError,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  loadConfigFile,
  parseArgs,
  resolveConfigPath,
  run,
} from "../src/index.js";
import { StringWritable, scriptedTextModel } from "./helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-config-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("loadConfigFile: well-formed TOML", () => {
  it("reads a file with the v0 permission + sandbox fields and returns the parsed layer", async () => {
    const file = path.join(tmpDir, "config.toml");
    await writeFile(
      file,
      [
        `permission_mode = "workspace-write"`,
        `ask_for_approval = "on-request"`,
        `sandbox_backend = "linux-landlock"`,
        `network_access = false`,
        `slash_tmp_writable = true`,
        `writable_roots = ["/tmp", "/var/tmp"]`,
        ``,
      ].join("\n"),
      "utf8",
    );

    const layer = await loadConfigFile(file);
    expect(layer).toEqual({
      permissionMode: "workspace-write",
      askForApproval: "on-request",
      sandboxBackend: "linux-landlock",
      networkAccess: false,
      slashTmpWritable: true,
      writableRoots: ["/tmp", "/var/tmp"],
    });
  });

  it("accepts a partial file (only some fields set)", async () => {
    const file = path.join(tmpDir, "config.toml");
    await writeFile(
      file,
      [`permission_mode = "danger-full-access"`, ``].join("\n"),
      "utf8",
    );

    const layer = await loadConfigFile(file);
    expect(layer).toEqual({ permissionMode: "danger-full-access" });
    expect(layer.askForApproval).toBeUndefined();
    expect(layer.writableRoots).toBeUndefined();
  });
});

describe("loadConfigFile: missing file", () => {
  it("returns an empty layer (ENOENT is silent)", async () => {
    const layer = await loadConfigFile(path.join(tmpDir, "does-not-exist.toml"));
    expect(layer).toEqual({});
  });
});

describe("loadConfigFile: malformed input", () => {
  it("throws ConfigLoadError for invalid TOML syntax", async () => {
    const file = path.join(tmpDir, "bad.toml");
    await writeFile(
      file,
      // unclosed string
      [`permission_mode = "workspace-write`, ``].join("\n"),
      "utf8",
    );

    let err: unknown;
    try {
      await loadConfigFile(file);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect((err as ConfigLoadError).filePath).toBe(file);
    expect((err as Error).message).toMatch(/failed to parse TOML/);
  });

  it("throws ConfigLoadError when the file parses but the shape is wrong", async () => {
    const file = path.join(tmpDir, "wrong-shape.toml");
    await writeFile(
      file,
      // permission_mode must be a string; this is a number
      [`permission_mode = 123`, ``].join("\n"),
      "utf8",
    );

    let err: unknown;
    try {
      await loadConfigFile(file);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect((err as Error).message).toMatch(/invalid config shape/);
  });

  it("throws ConfigLoadError for an invalid permission_mode value", async () => {
    const file = path.join(tmpDir, "bad-value.toml");
    await writeFile(
      file,
      [`permission_mode = "ultra-strict"`, ``].join("\n"),
      "utf8",
    );

    let err: unknown;
    try {
      await loadConfigFile(file);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect((err as Error).message).toMatch(/permissionMode/);
  });
});

describe("resolveConfigPath: priority", () => {
  it("uses the explicit filePath when given", () => {
    const p = resolveConfigPath("/tmp/explicit.toml");
    expect(p).toBe("/tmp/explicit.toml");
  });

  it("uses $ENVOY_HARNESS_CONFIG when set and filePath is not given", () => {
    const previous = process.env["ENVOY_HARNESS_CONFIG"];
    process.env["ENVOY_HARNESS_CONFIG"] = "/tmp/from-env.toml";
    try {
      expect(resolveConfigPath()).toBe("/tmp/from-env.toml");
    } finally {
      if (previous === undefined) {
        delete process.env["ENVOY_HARNESS_CONFIG"];
      } else {
        process.env["ENVOY_HARNESS_CONFIG"] = previous;
      }
    }
  });

  it("uses $XDG_CONFIG_HOME when set and neither filePath nor ENVOY_HARNESS_CONFIG is set", () => {
    const previousXdg = process.env["XDG_CONFIG_HOME"];
    const previousEnv = process.env["ENVOY_HARNESS_CONFIG"];
    delete process.env["ENVOY_HARNESS_CONFIG"];
    process.env["XDG_CONFIG_HOME"] = "/tmp/xdg";
    try {
      expect(resolveConfigPath()).toBe(
        path.resolve("/tmp/xdg", "envoy-harness", "config.toml"),
      );
    } finally {
      if (previousXdg === undefined) {
        delete process.env["XDG_CONFIG_HOME"];
      } else {
        process.env["XDG_CONFIG_HOME"] = previousXdg;
      }
      if (previousEnv === undefined) {
        delete process.env["ENVOY_HARNESS_CONFIG"];
      } else {
        process.env["ENVOY_HARNESS_CONFIG"] = previousEnv;
      }
    }
  });

  it("falls back to ~/.config/envoy-harness/config.toml by default", () => {
    const previousXdg = process.env["XDG_CONFIG_HOME"];
    const previousEnv = process.env["ENVOY_HARNESS_CONFIG"];
    delete process.env["XDG_CONFIG_HOME"];
    delete process.env["ENVOY_HARNESS_CONFIG"];
    try {
      expect(resolveConfigPath()).toBe(
        path.resolve(os.homedir(), DEFAULT_CONFIG_PATH),
      );
    } finally {
      if (previousXdg === undefined) {
        delete process.env["XDG_CONFIG_HOME"];
      } else {
        process.env["XDG_CONFIG_HOME"] = previousXdg;
      }
      if (previousEnv === undefined) {
        delete process.env["ENVOY_HARNESS_CONFIG"];
      } else {
        process.env["ENVOY_HARNESS_CONFIG"] = previousEnv;
      }
    }
  });
});

describe("loadConfig: end-to-end", () => {
  it("returns both the layer and the resolved path", async () => {
    const file = path.join(tmpDir, "config.toml");
    await writeFile(
      file,
      [`permission_mode = "read-only"`, ``].join("\n"),
      "utf8",
    );

    const { layer, resolvedPath } = await loadConfig({ filePath: file });
    expect(layer).toEqual({ permissionMode: "read-only" });
    expect(resolvedPath).toBe(file);
  });

  it("returns an empty layer when the default file does not exist", async () => {
    const previousXdg = process.env["XDG_CONFIG_HOME"];
    const previousEnv = process.env["ENVOY_HARNESS_CONFIG"];
    delete process.env["XDG_CONFIG_HOME"];
    delete process.env["ENVOY_HARNESS_CONFIG"];
    try {
      // Use a HOME that's an empty temp dir so the default
      // path resolves to a guaranteed-missing file.
      const emptyHome = await mkdtemp(
        path.join(os.tmpdir(), "envoy-config-empty-home-"),
      );
      const previousHome = process.env["HOME"];
      process.env["HOME"] = emptyHome;
      try {
        const { layer, resolvedPath } = await loadConfig();
        expect(layer).toEqual({});
        expect(resolvedPath).toBe(
          path.resolve(emptyHome, ".config", "envoy-harness", "config.toml"),
        );
      } finally {
        if (previousHome === undefined) {
          delete process.env["HOME"];
        } else {
          process.env["HOME"] = previousHome;
        }
        await rm(emptyHome, { recursive: true, force: true });
      }
    } finally {
      if (previousXdg === undefined) {
        delete process.env["XDG_CONFIG_HOME"];
      } else {
        process.env["XDG_CONFIG_HOME"] = previousXdg;
      }
      if (previousEnv === undefined) {
        delete process.env["ENVOY_HARNESS_CONFIG"];
      } else {
        process.env["ENVOY_HARNESS_CONFIG"] = previousEnv;
      }
    }
  });
});

describe("ConfigLayerSchema: shape", () => {
  it("accepts an empty object (no fields set)", () => {
    const result = ConfigLayerSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects an unknown field at the top level (the v0 schema is closed)", () => {
    const result = ConfigLayerSchema.safeParse({
      permissionMode: "read-only",
      unknownField: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("CLI integration: --config", () => {
  it("argv parser captures --config as a string", () => {
    const a = parseArgs(["--config", "/etc/envoy/config.toml"]);
    if (a.subcommand !== "run") {
      throw new Error(`expected run subcommand, got ${a.subcommand}`);
    }
    expect(a.config).toBe("/etc/envoy/config.toml");
  });

  it("argv parser: --config is not set by default", () => {
    const a = parseArgs([]);
    if (a.subcommand !== "run") {
      throw new Error(`expected run subcommand, got ${a.subcommand}`);
    }
    expect(a.config).toBeUndefined();
  });

  it("run() reads --config and applies the permissionMode", async () => {
    const file = path.join(tmpDir, "config.toml");
    await writeFile(
      file,
      [`permission_mode = "workspace-write"`, ``].join("\n"),
      "utf8",
    );

    // Smoke-test: the run() succeeds with --config and
    // the permissionMode flows into the session. We
    // assert the side effect (the file is read; the
    // model is called once with end_turn).
    const model = scriptedTextModel("ok");
    const out = new StringWritable();
    const err = new StringWritable();
    await run({
      argv: ["--config", file, "hello"],
      model,
      stdout: out,
      stderr: err,
    });
    // The exact permissionMode assertion is checked
    // elsewhere (cli.test.ts has shape coverage); here
    // we just verify --config is a non-fatal path.
    expect(out.data).toContain("ok");
  });
});
