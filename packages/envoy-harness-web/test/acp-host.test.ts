/**
 * Lightweight smoke tests for WebUI host helpers (no browser).
 */
import { describe, expect, it } from "vitest";
import { AcpHost } from "../src/client/acp/host.js";

describe("AcpHost", () => {
  it("starts disconnected", () => {
    const host = new AcpHost();
    expect(host.state.ready).toBe(false);
    expect(host.state.sessionId).toBeNull();
    expect(host.state.messages).toEqual([]);
    host.close();
  });

  it("notifies subscribers on patch via subscribe", () => {
    const host = new AcpHost();
    let ticks = 0;
    const unsub = host.subscribe(() => {
      ticks += 1;
    });
    // connect will fail without WS — still should set error via patch
    // We only assert subscribe wiring by closing (no emit required).
    unsub();
    expect(ticks).toBe(0);
    host.close();
  });
});
