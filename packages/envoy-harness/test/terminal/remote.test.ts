/**
 * R4.13 — mesh-remote TerminalTransport (hermetic fake).
 */

import { describe, expect, it } from "vitest";

import {
  createFakeTerminalBackend,
  createTerminalSessionService,
  FakeRemoteTerminalTransport,
  formatRemoteTerminalRef,
  isRemoteTerminalRef,
  NOOP_REMOTE_TERMINAL_TRANSPORT,
  parseRemoteTerminalRef,
  RemoteTerminalError,
} from "../../src/terminal/index.js";

describe("R4.13 remote terminal refs", () => {
  it("formats and parses peer:// refs", () => {
    const ref = formatRemoteTerminalRef("alice", "pty-1");
    expect(ref).toBe("peer://alice/terminals/pty-1");
    expect(isRemoteTerminalRef(ref)).toBe(true);
    expect(parseRemoteTerminalRef(ref)).toEqual({
      peerId: "alice",
      sessionId: "pty-1",
    });
    expect(() => parseRemoteTerminalRef("pty-1")).toThrow(RemoteTerminalError);
  });
});

describe("FakeRemoteTerminalTransport", () => {
  it("reads, lists, and kills across attached peers", async () => {
    const service = createTerminalSessionService();
    service.registerBackend(createFakeTerminalBackend({ pid: 7 }));
    const spawned = await service.spawn("owner-1", {
      type: "fake",
      name: "main",
    });

    const transport = new FakeRemoteTerminalTransport();
    transport.attachPeer("worker-b", service, { viewer: "owner-1" });
    const ref = formatRemoteTerminalRef("worker-b", spawned.sessionId);
    const signal = new AbortController().signal;

    const session = await transport.getSession(ref, signal);
    expect(session.sessionId).toBe(spawned.sessionId);
    expect(session.name).toBe("main");

    const listed = await transport.listSessions("peer://worker-b", signal);
    expect(listed.map((s) => s.sessionId)).toContain(spawned.sessionId);

    const text = await transport.readOutput(ref, signal);
    expect(typeof text).toBe("string");

    const killed = await transport.kill(ref, signal, "done");
    expect(killed).toBe(true);
    await expect(transport.getSession(ref, signal)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws NOT_FOUND for unknown peer", async () => {
    const transport = new FakeRemoteTerminalTransport();
    await expect(
      transport.listSessions("ghost", new AbortController().signal),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("NOOP_REMOTE_TERMINAL_TRANSPORT", () => {
  it("stays NOT_CONFIGURED", async () => {
    await expect(
      NOOP_REMOTE_TERMINAL_TRANSPORT.readOutput(
        formatRemoteTerminalRef("p", "t"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});
