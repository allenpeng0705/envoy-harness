/**
 * ACP session/set_decision param parsing (incl. nested B/F patches).
 */

import { describe, expect, it } from "vitest";

import { parseSetDecisionParams } from "../../src/protocol/acp-params.js";
import { JsonRpcError } from "../../src/protocol/types.js";

describe("parseSetDecisionParams", () => {
  it("parses mode + nested modelRouter / inputGuard", () => {
    const p = parseSetDecisionParams({
      sessionId: "s1",
      mode: "enforce",
      modelRouter: {
        enabled: true,
        defaultProfile: "strong",
        profiles: [
          {
            id: "fast",
            provider: "openai",
            model: "gpt-4o-mini",
            toolsOk: false,
          },
          {
            id: "strong",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        ],
      },
      inputGuard: {
        enabled: true,
        injectionThreshold: 0.9,
        honorBlock: true,
      },
    });
    expect(p.sessionId).toBe("s1");
    expect(p.mode).toBe("enforce");
    expect(p.modelRouter?.enabled).toBe(true);
    expect(p.modelRouter?.profiles).toHaveLength(2);
    expect(p.modelRouter?.profiles?.[0]?.toolsOk).toBe(false);
    expect(p.inputGuard?.enabled).toBe(true);
    expect(p.inputGuard?.injectionThreshold).toBe(0.9);
  });

  it("parses safeAuto honorDeny", () => {
    const p = parseSetDecisionParams({
      sessionId: "s1",
      safeAuto: { honorDeny: true, enabled: true },
    });
    expect(p.safeAuto).toEqual({ honorDeny: true, enabled: true });
  });

  it("rejects empty patch", () => {
    expect(() => parseSetDecisionParams({ sessionId: "s1" })).toThrow(
      JsonRpcError,
    );
  });

  it("drops invalid profile entries", () => {
    const p = parseSetDecisionParams({
      sessionId: "s1",
      modelRouter: {
        profiles: [
          { id: "ok", provider: "openai", model: "gpt-4o" },
          { id: "bad" },
        ],
      },
    });
    expect(p.modelRouter?.profiles).toEqual([
      { id: "ok", provider: "openai", model: "gpt-4o" },
    ]);
  });
});
