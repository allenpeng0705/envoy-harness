/**
 * setPermissionPreset(mobile|webdev) must expand sandbox roots.
 */

import { describe, expect, it } from "vitest";

import { Agent } from "../../src/agent.js";
import { InMemorySession } from "../../src/session.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { FakeModel, textResponse } from "../fixtures/fake-model.js";

function makeAgent(cwd = "/tmp/app"): Agent {
  const session = new InMemorySession("s1", {
    cwd,
    permissionMode: "read-only",
    startedAt: new Date().toISOString(),
  });
  return new Agent({
    model: new FakeModel([textResponse("ok")]),
    tools: new ToolRegistry(),
    session,
    cwd,
  });
}

describe("Agent.setPermissionPreset(mobile)", () => {
  it("expands network + CoreSimulator roots and keeps preset name", () => {
    const agent = makeAgent();
    const preset = agent.setPermissionPreset("mobile");
    expect(preset.name).toBe("mobile");
    expect(agent.sandboxPolicy.networkAccess).toBe(true);
    expect(
      agent.sandboxPolicy.writableRoots.some((r) =>
        r.includes("CoreSimulator"),
      ),
    ).toBe(true);
    expect(agent.getPermissionPreset()).toBe("mobile");
    expect(agent.autoRun).toBe("safe-only");
  });
});

describe("Agent.setPermissionPreset(webdev)", () => {
  it("expands network + .next roots and keeps preset name", () => {
    const agent = makeAgent("/tmp/spa");
    const preset = agent.setPermissionPreset("webdev");
    expect(preset.name).toBe("webdev");
    expect(agent.sandboxPolicy.networkAccess).toBe(true);
    expect(
      agent.sandboxPolicy.writableRoots.some((r) => r.endsWith("/.next")),
    ).toBe(true);
    expect(agent.getPermissionPreset()).toBe("webdev");
    expect(agent.autoRun).toBe("safe-only");
  });

  it("switching mobile → webdev replaces SDK roots with webdev roots", () => {
    const agent = makeAgent("/tmp/spa");
    agent.setPermissionPreset("mobile");
    agent.setPermissionPreset("webdev");
    expect(agent.getPermissionPreset()).toBe("webdev");
    expect(
      agent.sandboxPolicy.writableRoots.some((r) =>
        r.includes("CoreSimulator"),
      ),
    ).toBe(false);
    expect(
      agent.sandboxPolicy.writableRoots.some((r) => r.includes("/.next")),
    ).toBe(true);
  });
});
