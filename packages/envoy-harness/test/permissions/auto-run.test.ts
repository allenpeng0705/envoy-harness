/**
 * Session-level auto-run permission policy (TUI / ACP hosts).
 */

import { describe, expect, it } from "vitest";

import {
  isAutoRunSafeBashCommand,
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

  it("returns undefined when the policy is unset (caller falls back)", () => {
    expect(shouldAskUnderAutoRun(undefined, "bash", {})).toBeUndefined();
  });

  it("classifies read-only bash commands", () => {
    expect(isAutoRunSafeBashCommand("cat package.json")).toBe(true);
    expect(isAutoRunSafeBashCommand("ls && rm -rf /")).toBe(false);
    expect(isAutoRunSafeBashCommand("curl http://x")).toBe(false);
    expect(isAutoRunSafeBashCommand("")).toBe(false);
  });
});
