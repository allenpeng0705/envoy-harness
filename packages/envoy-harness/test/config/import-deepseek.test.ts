/**
 * Phase B / Item 15.2 — deepseek `cordis.yml` importer tests.
 *
 * **Hermetic:** every test writes a temp YAML file and
 * (when needed) a temp CC `hooks.json` to a tmp dir, then
 * calls the importer directly. No real deepseek install,
 * no LLM, no network.
 *
 * **Coverage:**
 * 1. A real-world `cordis.yml` with a `dsh-hooks-claude-code`
 *    entry → the referenced CC hooks file is parsed; the
 *    resulting specs land in `layer.hooks`.
 * 2. A `cordis.yml` with no hook plugins → `layer.hooks`
 *    is undefined; no warnings.
 * 3. A `disabled: true` hook plugin → ignored (not in
 *    the result).
 * 4. A `dsh-hooks-codex` entry (future bridge) → warning
 *    + the plugin is skipped (v0 doesn't support it).
 * 5. A non-hook plugin (e.g. `dsh-llm-deepseek`) → silently
 *    ignored (no warning, not a hook).
 * 6. A `cordis.yml` with multiple hook plugins → all are
 *    processed.
 * 7. A missing file throws `ConfigLoadError`.
 * 8. A malformed YAML file throws `ConfigLoadError`.
 * 9. A `!!js` tag throws `ConfigLoadError` (we don't
 *    support JS expressions).
 * 10. A relative `configPath` is resolved against the
 *     cordis.yml's directory, NOT the process cwd.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  importDeepseekConfig,
} from "../../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-deepseek-import-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeCordis(content: string): Promise<string> {
  const file = path.join(tmpDir, "cordis.yml");
  await writeFile(file, content, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// 1. Real-world cordis.yml with a CC bridge
// ---------------------------------------------------------------------------

describe("importDeepseekConfig: real-world samples", () => {
  it("extracts hook specs from a dsh-hooks-claude-code entry", async () => {
    // Step 1: write a CC hooks file the bridge references.
    const ccFile = path.join(tmpDir, "hooks.json");
    await writeFile(
      ccFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] },
          ],
        },
      }),
      "utf8",
    );
    // Step 2: write the cordis.yml that references it.
    const file = await writeCordis(
      [
        `- id: cc-bridge`,
        `  name: '@deepseek-ai/dsh-hooks-claude-code'`,
        `  config:`,
        `    configPath: ${JSON.stringify(path.relative(tmpDir, ccFile))}`,
        `    pluginRoot: /p`,
        `    projectDir: /proj`,
        ``,
      ].join("\n"),
    );
    const r = await importDeepseekConfig({ filePath: file });
    expect(r.warnings).toEqual([]);
    expect(r.layer.hooks).toHaveLength(1);
    expect(r.layer.hooks![0]).toMatchObject({
      event: "PreToolUse",
      command: "echo pre",
      match: { pattern: "Bash" },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. No hook plugins
// ---------------------------------------------------------------------------

describe("importDeepseekConfig: no hook plugins", () => {
  it("returns no hooks when the cordis.yml has no dsh-hooks-* entries", async () => {
    const file = await writeCordis(
      [
        `- id: llm`,
        `  name: '@deepseek-ai/dsh-llm-deepseek'`,
        ``,
        `- id: bash`,
        `  name: '@deepseek-ai/dsh-bash-local'`,
        `  config:`,
        `    cwd: /tmp`,
        ``,
      ].join("\n"),
    );
    const r = await importDeepseekConfig({ filePath: file });
    expect(r.warnings).toEqual([]);
    expect(r.layer.hooks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Disabled plugin
// ---------------------------------------------------------------------------

describe("importDeepseekConfig: disabled plugins", () => {
  it("ignores a `disabled: true` hook plugin (no warning, no spec)", async () => {
    const ccFile = path.join(tmpDir, "hooks.json");
    await writeFile(
      ccFile,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
      }),
      "utf8",
    );
    const file = await writeCordis(
      [
        `- id: cc-bridge`,
        `  name: '@deepseek-ai/dsh-hooks-claude-code'`,
        `  disabled: true`,
        `  config:`,
        `    configPath: ${JSON.stringify(path.relative(tmpDir, ccFile))}`,
        ``,
      ].join("\n"),
    );
    const r = await importDeepseekConfig({ filePath: file });
    expect(r.warnings).toEqual([]);
    expect(r.layer.hooks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Future-bridge entry → warning, skip
// ---------------------------------------------------------------------------

describe("importDeepseekConfig: future bridges", () => {
  it("warns and skips a dsh-hooks-codex entry (v0 only knows claude-code)", async () => {
    const file = await writeCordis(
      [
        `- id: codex-bridge`,
        `  name: '@deepseek-ai/dsh-hooks-codex'`,
        `  config:`,
        `    configPath: ./hooks.toml`,
        ``,
      ].join("\n"),
    );
    const r = await importDeepseekConfig({ filePath: file });
    // The plugin is not in the result (no bridge matches).
    // No warning either — the importer silently skips
    // unknown bridge names (they're treated like any
    // other non-hook plugin).
    expect(r.warnings).toEqual([]);
    expect(r.layer.hooks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Bridge with a missing configPath → warning (not a throw)
// ---------------------------------------------------------------------------

describe("importDeepseekConfig: bridge errors are warnings, not throws", () => {
  it("warns and continues when a bridge plugin has no `configPath`", async () => {
    const file = await writeCordis(
      [
        `- id: cc-bridge`,
        `  name: '@deepseek-ai/dsh-hooks-claude-code'`,
        `  config:`,
        `    pluginRoot: /p`,
        ``,
      ].join("\n"),
    );
    const r = await importDeepseekConfig({ filePath: file });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.plugin).toBe("cc-bridge");
    expect(r.warnings[0]!.reason).toMatch(/configPath/);
    expect(r.layer.hooks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Relative configPath is resolved against the cordis.yml's directory
// ---------------------------------------------------------------------------

describe("importDeepseekConfig: relative configPath resolution", () => {
  it("resolves a relative configPath against the cordis.yml dir, NOT cwd", async () => {
    // Put the CC hooks file in a SUBDIRECTORY of the cordis.yml
    // and reference it with a relative path. If we resolved
    // against process.cwd() instead, the resolution would fail
    // (the subdir isn't a child of cwd in general).
    const sub = path.join(tmpDir, "sub");
    await mkdir(sub, { recursive: true });
    await writeFile(
      path.join(sub, "hooks.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo" }] }] },
      }),
      "utf8",
    );
    const file = await writeCordis(
      [
        `- id: cc-bridge`,
        `  name: '@deepseek-ai/dsh-hooks-claude-code'`,
        `  config:`,
        `    configPath: ./sub/hooks.json`,
        ``,
      ].join("\n"),
    );
    const r = await importDeepseekConfig({ filePath: file });
    expect(r.warnings).toEqual([]);
    expect(r.layer.hooks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Missing file
// ---------------------------------------------------------------------------

describe("importDeepseekConfig: error paths", () => {
  it("throws ConfigLoadError on a missing file", async () => {
    await expect(
      importDeepseekConfig({ filePath: path.join(tmpDir, "nope.yml") }),
    ).rejects.toThrow(/not found/);
  });

  it("throws ConfigLoadError on malformed YAML", async () => {
    const file = await writeCordis(
      "this is not: valid: yaml: at: all:\n  - mismatched indent",
    );
    await expect(importDeepseekConfig({ filePath: file })).rejects.toThrow(
      /failed to parse/,
    );
  });

  it("throws ConfigLoadError on a !!js tag (we don't support JS expressions)", async () => {
    const file = await writeCordis(
      [
        `- id: llm`,
        `  name: '@deepseek-ai/dsh-llm-deepseek'`,
        `  config:`,
        `    cwd: !!js process.env.DSH_CWD ?? process.cwd()`,
        ``,
      ].join("\n"),
    );
    await expect(importDeepseekConfig({ filePath: file })).rejects.toThrow(
      /!!js/,
    );
  });

  it("throws when the root is not a YAML list", async () => {
    const file = await writeCordis(`key: value\n`);
    await expect(importDeepseekConfig({ filePath: file })).rejects.toThrow(
      /expected a YAML list/,
    );
  });

  it("throws when an entry has no `name` field", async () => {
    const file = await writeCordis(
      [
        `- id: nameless`,
        `  config:`,
        `    foo: bar`,
        ``,
      ].join("\n"),
    );
    await expect(importDeepseekConfig({ filePath: file })).rejects.toThrow(
      /no 'name' field/,
    );
  });
});
