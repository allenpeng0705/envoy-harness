/**
 * Phase C / Item 9 — terminal session service tests (hermetic).
 */

import { describe, expect, it } from "vitest";

import {
  createFakeTerminalBackend,
  createTerminalSessionService,
  TerminalError,
} from "../../src/terminal/index.js";

describe("createTerminalSessionService", () => {
  it("registers backends and rejects duplicates", () => {
    const service = createTerminalSessionService();
    const backend = createFakeTerminalBackend();
    service.registerBackend(backend);
    expect(service.listBackends()).toEqual(["fake"]);
    expect(() =>
      service.registerBackend(createFakeTerminalBackend()),
    ).toThrow(TerminalError);
    expect(() =>
      service.registerBackend(createFakeTerminalBackend()),
    ).toThrow(/DUPLICATE_BACKEND|already registered/);
  });

  it("fences every operation to the owning session", async () => {
    const service = createTerminalSessionService();
    service.registerBackend(createFakeTerminalBackend({ pid: 42 }));
    const created = await service.spawn("alice", {
      type: "fake",
      name: "main",
      cwd: "/tmp",
    });
    expect(created).toMatchObject({
      sessionId: "pty-1",
      name: "main",
      type: "fake",
      pid: 42,
      motd: "fake terminal ready",
      status: { kind: "running" },
    });

    expect(service.list("alice")).toHaveLength(1);
    expect(service.list("bob")).toEqual([]);

    expect(() => service.read("bob", created.sessionId)).toThrow(
      TerminalError,
    );
    try {
      service.read("bob", created.sessionId);
    } catch (err) {
      expect(err).toMatchObject({ code: "FOREIGN_SESSION" });
    }
    await expect(
      service.signal("bob", created.sessionId, "SIGINT"),
    ).rejects.toMatchObject({ code: "FOREIGN_SESSION" });
    await expect(
      service.kill("bob", created.sessionId),
    ).rejects.toMatchObject({ code: "FOREIGN_SESSION" });
    expect(() =>
      service.startSend("bob", created.sessionId, {
        text: "x",
        submit: true,
      }),
    ).toThrow(
      expect.objectContaining({ code: "FOREIGN_SESSION" }),
    );

    await service.dispose();
  });

  it("rejects a second concurrent send with SEND_ACTIVE", async () => {
    const service = createTerminalSessionService();
    service.registerBackend(
      createFakeTerminalBackend({ sendDelayMs: 50 }),
    );
    const created = await service.spawn("s1", { type: "fake" });
    const first = service.startSend("s1", created.sessionId, {
      text: "echo hi",
      submit: true,
    });
    expect(() =>
      service.startSend("s1", created.sessionId, {
        text: "pwd",
        submit: true,
      }),
    ).toThrow(expect.objectContaining({ code: "SEND_ACTIVE" }));
    const result = await first.done;
    expect(result.waitReason).toBe("inferred_idle");
    expect(result.viewport).toBe("echo hi\n");

    const second = service.startSend("s1", created.sessionId, {
      text: "pwd",
      submit: true,
    });
    await second.done;
    await service.dispose();
  });

  it("lists owned sessions and kill removes them", async () => {
    const service = createTerminalSessionService();
    const backend = createFakeTerminalBackend();
    service.registerBackend(backend);
    const a = await service.spawn("s1", { type: "fake", name: "a" });
    const b = await service.spawn("s1", { type: "fake", name: "b" });
    expect(service.list("s1").map((s) => s.sessionId)).toEqual([
      a.sessionId,
      b.sessionId,
    ]);

    expect(await service.kill("s1", a.sessionId)).toBe(true);
    expect(service.list("s1")).toHaveLength(1);
    expect(backend.sessions.get(a.sessionId)?.closed).toEqual([
      "model request",
    ]);
    await expect(service.kill("s1", a.sessionId)).rejects.toMatchObject({
      code: "NO_SESSION",
    });

    expect(await service.kill("s1", b.sessionId, "done")).toBe(true);
    expect(service.list("s1")).toEqual([]);
    await service.dispose();
  });

  it("dispose closes all sessions", async () => {
    const service = createTerminalSessionService();
    const backend = createFakeTerminalBackend();
    service.registerBackend(backend);
    const created = await service.spawn("s1", { type: "fake" });
    await service.dispose();
    expect(backend.sessions.get(created.sessionId)?.closed).toEqual([
      "PTY service disposed",
    ]);
    await expect(
      service.spawn("s1", { type: "fake" }),
    ).rejects.toMatchObject({ code: "SERVICE_DISPOSING" });
  });

  it("rejects unknown backends and duplicate names", async () => {
    const service = createTerminalSessionService();
    await expect(
      service.spawn("s1", { type: "missing" }),
    ).rejects.toMatchObject({ code: "NO_BACKEND" });
    service.registerBackend(createFakeTerminalBackend());
    await service.spawn("s1", { type: "fake", name: "main" });
    await expect(
      service.spawn("s1", { type: "fake", name: "main" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_NAME" });
    // Different owners may reuse the same display name.
    await expect(
      service.spawn("s2", { type: "fake", name: "main" }),
    ).resolves.toMatchObject({ name: "main", sessionId: "pty-2" });
    await service.dispose();
  });
});
