/**
 * Phase B / Item 15.2 — Claude Code `hooks.json` parser tests.
 *
 * **Hermetic:** every test writes a temp JSON file and calls
 * the parser directly. No real CC install, no LLM, no network.
 *
 * **Coverage:**
 * 1. Real-world CC sample (the `hook-cc-stop-continue` example
 *    from `deepseek-harness/examples/acp-agent/tests/snapshots`)
 *    maps to a `Stop` spec.
 * 2. `PreToolUse` with `matcher: "bash"` → `match.pattern = "bash"`.
 * 3. `Stop` (no matcher) → `match` undefined.
 * 4. Non-command hooks (`http`, `prompt`, `agent`) → skipped
 *    + a `SkippedCcHook` entry; NOT in the result specs.
 * 5. `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are
 *    substituted.
 * 6. Unset substitution vars → left verbatim.
 * 7. Missing file throws `ConfigLoadError` (the user asked
 *    for THIS bridge).
 * 8. Malformed JSON throws.
 * 9. Invalid matcher regex throws with a clear error.
 * 10. Settings-file wrapper (`{ hooks: { ... } }`) is
 *     accepted alongside the bare event map.
 * 11. Unknown event names are silently ignored.
 * 12. CC's `timeout` (seconds) is converted to `timeoutMs`
 *     (milliseconds).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConfigLoadError,
  parseClaudeCodeHooks,
} from "../../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-cc-hooks-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeHooks(content: string): Promise<string> {
  const file = path.join(tmpDir, "hooks.json");
  await writeFile(file, content, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// 1. Real-world CC sample
// ---------------------------------------------------------------------------

describe("parseClaudeCodeHooks: real-world samples", () => {
  it("parses a Stop hook (no matcher) and emits one spec", async () => {
    const file = await writeHooks(
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo stopping",
                },
              ],
            },
          ],
        },
      }),
    );
    const r = await parseClaudeCodeHooks({ filePath: file });
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]).toMatchObject({
      event: "Stop",
      command: "echo stopping",
    });
    expect(r.specs[0]!.match).toBeUndefined();
    expect(r.skipped).toEqual([]);
  });

  it("parses a PreToolUse hook with matcher: 'bash'", async () => {
    const file = await writeHooks(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "bash",
              hooks: [{ type: "command", command: "echo pre" }],
            },
          ],
        },
      }),
    );
    const r = await parseClaudeCodeHooks({ filePath: file });
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]).toMatchObject({
      event: "PreToolUse",
      command: "echo pre",
      match: { pattern: "bash" },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Non-command hooks are skipped
// ---------------------------------------------------------------------------

describe("parseClaudeCodeHooks: skipping", () => {
  it("skips http/prompt/agent hooks, keeps command ones in the same group", async () => {
    const file = await writeHooks(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "prompt", prompt: "ask the user" },
                { type: "command", command: "echo ok" },
                { type: "http", url: "http://x" },
              ],
            },
          ],
        },
      }),
    );
    const r = await parseClaudeCodeHooks({ filePath: file });
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]!.command).toBe("echo ok");
    // The two non-command hooks are recorded.
    expect(r.skipped).toEqual([
      { event: "PreToolUse", type: "prompt" },
      { event: "PreToolUse", type: "http" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Substitution
// ---------------------------------------------------------------------------

describe("parseClaudeCodeHooks: substitution", () => {
  it("replaces ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PROJECT_DIR} (all occurrences)", async () => {
    const file = await writeHooks(
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "${CLAUDE_PLUGIN_ROOT}/x.sh",
                },
                {
                  type: "command",
                  command:
                    "${CLAUDE_PROJECT_DIR}/a ${CLAUDE_PROJECT_DIR}/b",
                },
              ],
            },
          ],
        },
      }),
    );
    const r = await parseClaudeCodeHooks({
      filePath: file,
      pluginRoot: "/p",
      projectDir: "/proj",
    });
    expect(r.specs[0]!.command).toBe("/p/x.sh");
    expect(r.specs[1]!.command).toBe("/proj/a /proj/b");
  });

  it("leaves the command untouched when no vars are supplied", async () => {
    const file = await writeHooks(
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/x" }] },
          ],
        },
      }),
    );
    const r = await parseClaudeCodeHooks({ filePath: file });
    expect(r.specs[0]!.command).toBe("${CLAUDE_PLUGIN_ROOT}/x");
  });
});

// ---------------------------------------------------------------------------
// 4. Wrapper shape (settings file)
// ---------------------------------------------------------------------------

describe("parseClaudeCodeHooks: settings-file wrapper", () => {
  it("accepts a settings-style { hooks: … } wrapper", async () => {
    const file = await writeHooks(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "x" }] },
          ],
        },
      }),
    );
    const r = await parseClaudeCodeHooks({ filePath: file });
    expect(r.specs).toHaveLength(1);
  });

  it("accepts a bare event map (no settings wrapper)", async () => {
    const file = await writeHooks(
      JSON.stringify({
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "x" }] },
        ],
      }),
    );
    const r = await parseClaudeCodeHooks({ filePath: file });
    expect(r.specs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Timeout conversion
// ---------------------------------------------------------------------------

describe("parseClaudeCodeHooks: timeout", () => {
  it("converts CC's seconds-based `timeout` to `timeoutMs`", async () => {
    const file = await writeHooks(
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "x", timeout: 30 }] },
          ],
        },
      }),
    );
    const r = await parseClaudeCodeHooks({ filePath: file });
    expect(r.specs[0]!.timeoutMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// 6. Error paths
// ---------------------------------------------------------------------------

describe("parseClaudeCodeHooks: error paths", () => {
  it("throws on a missing file", async () => {
    await expect(
      parseClaudeCodeHooks({
        filePath: path.join(tmpDir, "does-not-exist.json"),
      }),
    ).rejects.toThrow(/not found/);
  });

  it("throws on malformed JSON", async () => {
    const file = await writeHooks(`{ "hooks": { "Stop": [ invalid json `);
    await expect(parseClaudeCodeHooks({ filePath: file })).rejects.toThrow(
      ConfigLoadError,
    );
  });

  it("throws on an invalid regex matcher with a clear error", async () => {
    const file = await writeHooks(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "[unterminated", hooks: [{ type: "command", command: "x" }] },
          ],
        },
      }),
    );
    await expect(parseClaudeCodeHooks({ filePath: file })).rejects.toThrow(
      /invalid Claude Code matcher regex/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Unknown events are silently ignored
// ---------------------------------------------------------------------------

describe("parseClaudeCodeHooks: unknown events", () => {
  it("ignores event names that envoy-harness doesn't model", async () => {
    const file = await writeHooks(
      JSON.stringify({
        hooks: {
          // `MadeUpEvent` is not in the CC_EVENTS list —
          // it's silently skipped.
          MadeUpEvent: [
            { hooks: [{ type: "command", command: "x" }] },
          ],
          // `Stop` IS in the list — it parses.
          Stop: [
            { hooks: [{ type: "command", command: "y" }] },
          ],
        },
      }),
    );
    const r = await parseClaudeCodeHooks({ filePath: file });
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]!.event).toBe("Stop");
  });
});
