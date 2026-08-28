/**
 * U4+ — `--spawn` harness command resolution: provider/model forwarding.
 */

import { describe, expect, it } from "vitest";

import { resolveHarnessAcpCommand } from "../src/spawn.js";

describe("resolveHarnessAcpCommand", () => {
  it("appends provider/model harness args after --acp", () => {
    const resolved = resolveHarnessAcpCommand([
      "--provider",
      "deepseek",
      "--model",
      "deepseek-chat",
    ]);
    expect(resolved.args).toContain("--acp");
    expect(resolved.args).toContain("--provider");
    expect(resolved.args).toContain("deepseek");
    expect(resolved.args).toContain("--model");
    expect(resolved.args).toContain("deepseek-chat");
  });
});
