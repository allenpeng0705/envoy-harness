import { describe, expect, it } from "vitest";
import {
  createFakeTerminalBackend,
  createTerminalSessionService,
} from "../src/terminal/index.js";
import {
  closeTerminalOp,
  listTerminalsOp,
  openTerminalOp,
  writeTerminalOp,
} from "../src/protocol/terminal-ops.js";

describe("terminal-ops", () => {
  it("opens, writes, lists, and closes a fake PTY", async () => {
    const service = createTerminalSessionService();
    service.registerBackend(createFakeTerminalBackend());
    const opened = await openTerminalOp(service, "sess-1", {
      cwd: process.cwd(),
      name: "t1",
    });
    expect(opened.terminalId.length).toBeGreaterThan(0);
    expect(opened.type).toBe("fake");

    const deltas: string[] = [];
    const written = await writeTerminalOp(service, "sess-1", {
      terminalId: opened.terminalId,
      data: "hello",
      submit: true,
      onDelta: (d) => deltas.push(d),
    });
    expect(written.viewport.length).toBeGreaterThan(0);

    const listed = listTerminalsOp(service, "sess-1");
    expect(listed.terminals).toHaveLength(1);

    const closed = await closeTerminalOp(service, "sess-1", {
      terminalId: opened.terminalId,
    });
    expect(closed.closed).toBe(true);
  });
});
