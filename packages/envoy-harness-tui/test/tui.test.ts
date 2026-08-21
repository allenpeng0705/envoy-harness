/**
 * Hermetic TUI tests — in-process ACP, no TTY.
 */

import { describe, expect, it } from "vitest";

import { createFakeSessionBackend } from "@envoymesh/envoy-harness";

import { createInProcessTui } from "../src/in-process.js";
import { parseSlash } from "../src/slash.js";

describe("parseSlash", () => {
  it("recognizes help / cancel / quit", () => {
    expect(parseSlash("/help")?.kind).toBe("help");
    expect(parseSlash("/cancel")?.kind).toBe("cancel");
    expect(parseSlash("/quit")?.kind).toBe("quit");
    expect(parseSlash("hello")).toBeNull();
  });
});

describe("TuiSession via in-process ACP", () => {
  it("starts, prompts, and records transcript", async () => {
    const tui = createInProcessTui();
    await tui.session.start();
    expect(tui.session.sessionId).toMatch(/^sess-/);

    const result = await tui.session.submit("hello");
    expect(result).toBe("ok");
    const text = tui.session.renderTranscript();
    expect(text).toContain("[you] hello");
    expect(text).toContain("[agent] echo:hello");
    expect(text).toContain("stop: end_turn");
    tui.close();
  });

  it("handles /help and /quit", async () => {
    const tui = createInProcessTui();
    await tui.session.start();
    await tui.session.submit("/help");
    expect(tui.session.renderTranscript()).toContain("/cancel");
    expect(await tui.session.submit("/quit")).toBe("quit");
    tui.close();
  });

  it("routes permission via onPermission", async () => {
    const decisions: string[] = [];
    const tui = createInProcessTui({
      backend: createFakeSessionBackend({ permissionTool: "bash" }),
      onPermission: async (req) => {
        decisions.push(req.toolName);
        return "allow";
      },
    });
    await tui.session.start();
    await tui.session.submit("run");
    expect(decisions).toEqual(["bash"]);
    expect(tui.session.renderTranscript()).toContain("echo:run");
    tui.close();
  });

  it("/cancel records status", async () => {
    const tui = createInProcessTui();
    await tui.session.start();
    await tui.session.submit("/cancel");
    expect(tui.session.renderTranscript()).toContain("cancelled");
    tui.close();
  });
});

describe("TuiSession via attached CLI --acp pipes", () => {
  it("talks to run({ argv: ['--acp'] }) over PassThrough", async () => {
    const { PassThrough } = await import("node:stream");
    const { run } = await import("@envoymesh/envoy-harness");
    const { createAttachedTui } = await import("../src/attached.js");

    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const stderr = new PassThrough();
    const serverDone = run({
      argv: ["--acp", "--quiet"],
      stdin: c2s,
      stdout: s2c,
      stderr,
    });

    const tui = createAttachedTui({ input: s2c, output: c2s });
    await tui.session.start();
    expect(tui.session.sessionId).toMatch(/^sess-/);
    expect(await tui.session.submit("hello")).toBe("ok");
    expect(tui.session.renderTranscript()).toMatch(/echo:hello/);
    tui.close();
    c2s.end();
    await serverDone;
  });
});
