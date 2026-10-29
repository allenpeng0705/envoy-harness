/**
 * Session-level auto-run permission policy (TUI / ACP hosts).
 */

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isAutoRunSafeBashCommand,
  isPathInsideWorkspace,
  shouldAskUnderAutoRun,
} from "../../src/permissions/auto-run.js";

describe("shouldAskUnderAutoRun", () => {
  it("off never asks (always approve)", () => {
    expect(shouldAskUnderAutoRun("off", "bash", { command: "rm -rf /" })).toBe(
      false,
    );
    expect(shouldAskUnderAutoRun("off", "write", {})).toBe(false);
  });

  it("always-confirm asks for every tool", () => {
    expect(shouldAskUnderAutoRun("always-confirm", "read_file", {})).toBe(true);
    expect(shouldAskUnderAutoRun("always-confirm", "bash", {})).toBe(true);
  });

  it("safe-only auto-allows read-only tools + safe bash", () => {
    expect(shouldAskUnderAutoRun("safe-only", "read_file", {})).toBe(false);
    expect(
      shouldAskUnderAutoRun("safe-only", "bash", { command: "ls -la" }),
    ).toBe(false);
    expect(
      shouldAskUnderAutoRun("safe-only", "bash", { command: "git status" }),
    ).toBe(false);
    expect(
      shouldAskUnderAutoRun("safe-only", "bash", { command: "rm -rf /tmp/x" }),
    ).toBe(true);
    expect(shouldAskUnderAutoRun("safe-only", "write", {})).toBe(true);
  });

  it("safe-only auto-allows in-workspace write/edit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "envoy-auto-run-"));
    mkdirSync(path.join(root, "src"));
    expect(
      shouldAskUnderAutoRun(
        "safe-only",
        "write",
        { path: "src/a.ts" },
        { workspaceRoot: root },
      ),
    ).toBe(false);
    expect(
      shouldAskUnderAutoRun(
        "safe-only",
        "edit",
        { path: path.join(root, "src", "a.ts") },
        { workspaceRoot: root },
      ),
    ).toBe(false);
    expect(
      shouldAskUnderAutoRun(
        "safe-only",
        "apply_patch",
        { path: "README.md" },
        { workspaceRoot: root },
      ),
    ).toBe(false);
  });

  it("safe-only asks for out-of-workspace or unknown mutation paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "envoy-auto-run-"));
    expect(
      shouldAskUnderAutoRun(
        "safe-only",
        "write",
        { path: "/elsewhere/x.ts" },
        { workspaceRoot: root },
      ),
    ).toBe(true);
    expect(
      shouldAskUnderAutoRun(
        "safe-only",
        "write",
        { path: "../escape.txt" },
        { workspaceRoot: root },
      ),
    ).toBe(true);
    expect(
      shouldAskUnderAutoRun("safe-only", "write", {}, { workspaceRoot: root }),
    ).toBe(true);
    expect(
      shouldAskUnderAutoRun("safe-only", "write", { path: "src/a.ts" }),
    ).toBe(true);
  });

  it("safe-only asks when a workspace symlink escapes the project", () => {
    const root = mkdtempSync(path.join(tmpdir(), "envoy-auto-run-ws-"));
    const outside = mkdtempSync(path.join(tmpdir(), "envoy-auto-run-out-"));
    writeFileSync(path.join(outside, "secret.txt"), "nope");
    symlinkSync(outside, path.join(root, "escape"), "dir");
    expect(
      shouldAskUnderAutoRun(
        "safe-only",
        "write",
        { path: "escape/secret.txt" },
        { workspaceRoot: root },
      ),
    ).toBe(true);
    expect(isPathInsideWorkspace("escape/secret.txt", root)).toBe(false);
  });

  it("safe-only still asks for unsafe bash even with workspace root", () => {
    expect(
      shouldAskUnderAutoRun(
        "safe-only",
        "bash",
        { command: "rm -rf /tmp/x" },
        { workspaceRoot: "/proj" },
      ),
    ).toBe(true);
  });

  it("returns undefined when the policy is unset (caller falls back)", () => {
    expect(shouldAskUnderAutoRun(undefined, "bash", {})).toBeUndefined();
  });

  it("classifies read-only bash commands", () => {
    expect(isAutoRunSafeBashCommand("cat package.json")).toBe(true);
    expect(isAutoRunSafeBashCommand("ls && rm -rf /")).toBe(false);
    expect(isAutoRunSafeBashCommand("curl http://x")).toBe(false);
    expect(isAutoRunSafeBashCommand("")).toBe(false);
    expect(isAutoRunSafeBashCommand("git config user.name")).toBe(false);
    expect(isAutoRunSafeBashCommand("git status")).toBe(true);
    // Prefix escapes must not auto-allow a destructive payload.
    expect(isAutoRunSafeBashCommand("env rm -rf /tmp/x")).toBe(false);
    expect(isAutoRunSafeBashCommand("find . -delete")).toBe(false);
    expect(isAutoRunSafeBashCommand("command rm -rf /")).toBe(false);
  });

  it("isPathInsideWorkspace handles relative and absolute paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "envoy-auto-run-path-"));
    mkdirSync(path.join(root, "src"));
    expect(isPathInsideWorkspace("src/a.ts", root)).toBe(true);
    expect(isPathInsideWorkspace(path.join(root, "src", "a.ts"), root)).toBe(
      true,
    );
    expect(isPathInsideWorkspace("/elsewhere/a.ts", root)).toBe(false);
    expect(isPathInsideWorkspace("../x", root)).toBe(false);
  });
});
