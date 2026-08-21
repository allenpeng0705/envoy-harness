/**
 * Phase B / Item 15.1 — codex config.toml importer tests.
 *
 * **Hermetic:** every test writes a temp TOML file and
 * calls the importer directly. No real codex install, no
 * network, no LLM.
 *
 * **Coverage:**
 * 1. Happy path: a real-world codex sample (sandbox_mode
 *    + approval_policy + workspace-write fields) maps
 *    cleanly to the v0 ConfigLayer.
 * 2. Field inversions: `exclude_slash_tmp = true` →
 *    `slashTmpWritable: false`.
 * 3. Approval-policy approximations: `untrusted` →
 *    `unless-trusted` (with a warning), `on-failure` →
 *    `granular` (with a warning).
 * 4. Empty codex file → `{}` + no warnings.
 * 5. Ignored keys surface as warnings (with the reason);
 *    they are NOT in the returned `ConfigLayer`.
 * 6. Nested ignored tables (e.g. `mcp_servers`) surface
 *    ONE warning for the parent, with the reason — the
 *    children are not re-warned.
 * 7. Unknown codex keys (typos) surface as warnings with
 *    the "unknown" reason.
 * 8. Wrong-type values throw `ConfigLoadError` (not silent
 *    coercion).
 * 9. Missing file throws `ConfigLoadError` (the user
 *    explicitly asked for THIS file; ENOENT is NOT silent).
 * 10. Malformed TOML throws `ConfigLoadError`.
 * 11. `loadConfigWithImport` merges native + imported,
 *     with imported winning on conflict.
 * 12. `loadConfigWithImport` with an unsupported format
 *     throws.
 * 13. `isImportFormat` accepts "codex" and rejects
 *     anything else.
 * 14. `SUPPORTED_IMPORT_FORMATS` lists "codex" (v0 only).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConfigLoadError,
  SUPPORTED_IMPORT_FORMATS,
  importCodexConfig,
  isImportFormat,
  loadConfigWithImport,
} from "../../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-codex-import-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Write a codex-style TOML to a temp file and return the path. */
async function writeCodexConfig(content: string): Promise<string> {
  const file = path.join(tmpDir, "codex.toml");
  await writeFile(file, content, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("importCodexConfig: happy path", () => {
  it("maps a real-world codex sample to the v0 ConfigLayer", async () => {
    const file = await writeCodexConfig(
      [
        `sandbox_mode = "workspace-write"`,
        `approval_policy = "on-request"`,
        ``,
        `[sandbox_workspace_write]`,
        `writable_roots = ["/tmp", "/var/tmp"]`,
        `network_access = false`,
        `exclude_slash_tmp = true`,
        ``,
      ].join("\n"),
    );
    const result = await importCodexConfig({ filePath: file });
    expect(result.layer).toEqual({
      permissionMode: "workspace-write",
      askForApproval: "on-request",
      writableRoots: ["/tmp", "/var/tmp"],
      networkAccess: false,
      slashTmpWritable: false,
    });
    // No warnings: every field was mapped.
    expect(result.warnings).toEqual([]);
  });

  it("handles a minimal config (just sandbox_mode + approval_policy)", async () => {
    const file = await writeCodexConfig(
      [
        `sandbox_mode = "read-only"`,
        `approval_policy = "never"`,
        ``,
      ].join("\n"),
    );
    const result = await importCodexConfig({ filePath: file });
    expect(result.layer).toEqual({
      permissionMode: "read-only",
      askForApproval: "never",
    });
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Field inversions
// ---------------------------------------------------------------------------

describe("importCodexConfig: field inversions", () => {
  it("exclude_slash_tmp=true → slashTmpWritable=false", async () => {
    const file = await writeCodexConfig(
      [
        `sandbox_mode = "workspace-write"`,
        `[sandbox_workspace_write]`,
        `exclude_slash_tmp = true`,
        ``,
      ].join("\n"),
    );
    const result = await importCodexConfig({ filePath: file });
    expect(result.layer.slashTmpWritable).toBe(false);
  });

  it("exclude_slash_tmp=false → slashTmpWritable=true", async () => {
    const file = await writeCodexConfig(
      [
        `sandbox_mode = "workspace-write"`,
        `[sandbox_workspace_write]`,
        `exclude_slash_tmp = false`,
        ``,
      ].join("\n"),
    );
    const result = await importCodexConfig({ filePath: file });
    expect(result.layer.slashTmpWritable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Approval-policy approximations
// ---------------------------------------------------------------------------

describe("importCodexConfig: approval_policy approximations", () => {
  it("untrusted maps to unless-trusted + a warning", async () => {
    const file = await writeCodexConfig(`approval_policy = "untrusted"\n`);
    const result = await importCodexConfig({ filePath: file });
    expect(result.layer.askForApproval).toBe("unless-trusted");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.key).toBe("approval_policy");
    expect(result.warnings[0]!.reason).toMatch(/approximate/);
  });

  it("on-failure maps to granular + a warning", async () => {
    const file = await writeCodexConfig(`approval_policy = "on-failure"\n`);
    const result = await importCodexConfig({ filePath: file });
    expect(result.layer.askForApproval).toBe("granular");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.key).toBe("approval_policy");
    expect(result.warnings[0]!.reason).toMatch(/approximate/);
  });

  it("on-request maps exactly (no warning)", async () => {
    const file = await writeCodexConfig(`approval_policy = "on-request"\n`);
    const result = await importCodexConfig({ filePath: file });
    expect(result.layer.askForApproval).toBe("on-request");
    expect(result.warnings).toEqual([]);
  });

  it("never maps exactly (no warning)", async () => {
    const file = await writeCodexConfig(`approval_policy = "never"\n`);
    const result = await importCodexConfig({ filePath: file });
    expect(result.layer.askForApproval).toBe("never");
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------

describe("importCodexConfig: edge cases", () => {
  it("an empty codex file returns {} + no warnings", async () => {
    const file = await writeCodexConfig(``);
    const result = await importCodexConfig({ filePath: file });
    expect(result.layer).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it("an unknown top-level key surfaces a warning (and is NOT in the layer)", async () => {
    const file = await writeCodexConfig(
      [
        `sandbox_mode = "read-only"`,
        `permision_mode = "workspace-write"`,  // typo
        ``,
      ].join("\n"),
    );
    const result = await importCodexConfig({ filePath: file });
    // The typo is not mapped; the real field is.
    expect(result.layer.permissionMode).toBe("read-only");
    // One warning, naming the typo + the unknown reason.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.key).toBe("permision_mode");
    expect(result.warnings[0]!.reason).toMatch(/unknown/);
  });

  it("a known-but-ignored top-level key surfaces a warning with the reason", async () => {
    const file = await writeCodexConfig(
      [
        `model = "gpt-5.1"`,
        `[mcp_servers]`,
        `something = "x"`,
        ``,
      ].join("\n"),
    );
    const result = await importCodexConfig({ filePath: file });
    // `model` warning.
    const modelWarn = result.warnings.find((w) => w.key === "model");
    expect(modelWarn).toBeDefined();
    expect(modelWarn!.reason).toMatch(/not yet supported/);
    // `mcp_servers` warning (ONE warning for the whole table;
    // we don't re-warn for `mcp_servers.something`).
    const mcpWarnings = result.warnings.filter((w) =>
      w.key.startsWith("mcp_servers"),
    );
    expect(mcpWarnings).toHaveLength(1);
    expect(mcpWarnings[0]!.key).toBe("mcp_servers");
    expect(mcpWarnings[0]!.reason).toMatch(/MCP/);
    // Neither field is in the layer.
    expect(result.layer).toEqual({});
  });

  it("wrong-type sandbox_mode throws ConfigLoadError", async () => {
    const file = await writeCodexConfig(`sandbox_mode = 123\n`);
    await expect(importCodexConfig({ filePath: file })).rejects.toThrow(
      ConfigLoadError,
    );
  });

  it("unrecognized sandbox_mode value throws ConfigLoadError", async () => {
    const file = await writeCodexConfig(`sandbox_mode = "made-up-mode"\n`);
    await expect(importCodexConfig({ filePath: file })).rejects.toThrow(
      /unrecognized value/,
    );
  });

  it("missing file throws ConfigLoadError (NOT silent — user asked for THIS file)", async () => {
    const file = path.join(tmpDir, "does-not-exist.toml");
    await expect(importCodexConfig({ filePath: file })).rejects.toThrow(
      /not found/,
    );
  });

  it("malformed TOML throws ConfigLoadError", async () => {
    const file = await writeCodexConfig(
      `sandbox_mode = "workspace-write"\nTHIS_IS_NOT_VALID_TOML = \n`,
    );
    await expect(importCodexConfig({ filePath: file })).rejects.toThrow(
      /failed to parse codex TOML/,
    );
  });

  it("wrong-type writable_roots throws ConfigLoadError", async () => {
    const file = await writeCodexConfig(
      [
        `sandbox_mode = "workspace-write"`,
        `[sandbox_workspace_write]`,
        `writable_roots = "not-an-array"`,
        ``,
      ].join("\n"),
    );
    await expect(importCodexConfig({ filePath: file })).rejects.toThrow(
      /writable_roots/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. loadConfigWithImport (the merge primitive)
// ---------------------------------------------------------------------------

describe("loadConfigWithImport: merge semantics", () => {
  it("imported values win over native config on conflict", async () => {
    // Native config: read-only.
    const native = path.join(tmpDir, "native.toml");
    await writeFile(native, `permission_mode = "read-only"\n`, "utf8");
    // Imported codex: workspace-write.
    const codex = await writeCodexConfig(
      `sandbox_mode = "workspace-write"\n`,
    );
    const result = await loadConfigWithImport({
      filePath: native,
      importPath: codex,
      importFrom: "codex",
    });
    // Imported wins.
    expect(result.layer.permissionMode).toBe("workspace-write");
  });

  it("native-only fields are preserved when the imported config doesn't set them", async () => {
    const native = path.join(tmpDir, "native.toml");
    await writeFile(
      native,
      `permission_mode = "workspace-write"\nslash_tmp_writable = true\n`,
      "utf8",
    );
    const codex = await writeCodexConfig(
      `sandbox_mode = "danger-full-access"\n`,
    );
    const result = await loadConfigWithImport({
      filePath: native,
      importPath: codex,
      importFrom: "codex",
    });
    // Native `slashTmpWritable` is kept (imported didn't set it).
    expect(result.layer.slashTmpWritable).toBe(true);
    // Imported overrode the permission mode.
    expect(result.layer.permissionMode).toBe("danger-full-access");
  });

  it("an unsupported import format throws ConfigLoadError", async () => {
    const native = path.join(tmpDir, "native.toml");
    await writeFile(native, ``, "utf8");
    const codex = await writeCodexConfig(``);
    await expect(
      loadConfigWithImport({
        filePath: native,
        importPath: codex,
        importFrom: "made-up-format",
      }),
    ).rejects.toThrow(/unsupported import format/);
  });

  it("omitting importPath/importFrom falls back to native-only load", async () => {
    const native = path.join(tmpDir, "native.toml");
    await writeFile(native, `permission_mode = "workspace-write"\n`, "utf8");
    const result = await loadConfigWithImport({ filePath: native });
    expect(result.layer.permissionMode).toBe("workspace-write");
    expect(result.importResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Format helpers
// ---------------------------------------------------------------------------

describe("isImportFormat + SUPPORTED_IMPORT_FORMATS", () => {
  it("isImportFormat accepts 'codex'", () => {
    expect(isImportFormat("codex")).toBe(true);
  });

  it("isImportFormat accepts 'deepseek-cordis' (added in chunk 15.2)", () => {
    expect(isImportFormat("deepseek-cordis")).toBe(true);
  });

  it("isImportFormat rejects 'auto' (chunk 15.3+)", () => {
    expect(isImportFormat("auto")).toBe(false);
  });

  it("SUPPORTED_IMPORT_FORMATS is exactly ['codex', 'deepseek-cordis'] in v0.2", () => {
    expect(SUPPORTED_IMPORT_FORMATS).toEqual(["codex", "deepseek-cordis"]);
  });
});
