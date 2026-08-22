/**
 * Phase G — system-prompt assembly (deepseek parity) + the AGENTS.md
 * wiring that was previously disconnected.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Agent,
  agentsMdSection,
  buildAgentSystemPrompt,
  createSystemPromptRegistry,
  InMemorySession,
  newSessionId,
  terminalGuidanceSection,
  ToolRegistry,
} from "../src/index.js";

import { FakeModel, textResponse } from "./fixtures/fake-model.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sysprompt-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createSystemPromptRegistry", () => {
  it("renders sections in ascending order with blank-line joins", async () => {
    const registry = createSystemPromptRegistry();
    registry.register({ name: "b", order: 10, text: "second" });
    registry.register({ name: "a", order: -10, text: "first" });
    expect(await registry.render()).toBe("first\n\nsecond");
  });

  it("resolves provider sections and skips empty text", async () => {
    const registry = createSystemPromptRegistry();
    registry.register({
      name: "provider",
      order: 0,
      text: async () => "provided",
    });
    registry.register({ name: "empty", order: 5, text: "  " });
    expect(await registry.render()).toBe("provided");
  });

  it("throws on duplicate names and honors disposers", () => {
    const registry = createSystemPromptRegistry();
    const dispose = registry.register({ name: "x", order: 0, text: "1" });
    expect(() =>
      registry.register({ name: "x", order: 1, text: "2" }),
    ).toThrow(/already registered/);
    dispose();
    registry.register({ name: "x", order: 1, text: "2" });
    expect(registry.sections()).toHaveLength(1);
  });

  it("honors the complete flag (sole content; >1 throws)", async () => {
    const registry = createSystemPromptRegistry();
    registry.register({ name: "ctx", order: -100, text: "context" });
    registry.register({ name: "full", order: 0, text: "complete prompt", complete: true });
    expect(await registry.render()).toBe("complete prompt");

    const broken = createSystemPromptRegistry();
    broken.register({ name: "a", order: 0, text: "a", complete: true });
    broken.register({ name: "b", order: 1, text: "b", complete: true });
    await expect(broken.render()).rejects.toThrow(/complete sections/);
  });

  it("renders safely when destructured (no `this` dependence)", async () => {
    const registry = createSystemPromptRegistry();
    registry.register({ name: "a", order: 0, text: "hello" });
    const { render } = registry;
    expect(await render()).toBe("hello");
  });
});

describe("built-in sections", () => {
  it("ships the terminal guidance in deepseek's tool-guidance order slot", async () => {
    const section = terminalGuidanceSection();
    expect(section.order).toBe(100);
    expect(section.text).toContain("inferred_idle");
    expect(section.text).toContain("persistent terminal state");
  });

  it("renders AGENTS.md discovery content (previously disconnected)", async () => {
    await fs.mkdir(path.join(tmpDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "Project rules here.");
    const registry = createSystemPromptRegistry();
    registry.register(agentsMdSection(tmpDir));
    expect(await registry.render()).toContain("Project rules here.");
  });
});

describe("buildAgentSystemPrompt", () => {
  it("composes AGENTS.md + terminal guidance", async () => {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "Team conventions.");
    const prompt = await buildAgentSystemPrompt({ cwd: tmpDir });
    expect(prompt).toContain("Team conventions.");
    expect(prompt).toContain("inferred_idle");
  });

  it("adds plan mode and can drop terminal guidance", async () => {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "Rules.");
    const prompt = await buildAgentSystemPrompt({
      cwd: tmpDir,
      plan: true,
      terminalGuidance: false,
    });
    expect(prompt).toContain("PLAN MODE");
    expect(prompt).not.toContain("inferred_idle");
  });
});

describe("Agent system-prompt wiring", () => {
  it("prepends the assembled prompt as the system message on run", async () => {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "Always use tests.");
    const model = new FakeModel([textResponse("done")]);
    const session = new InMemorySession(newSessionId(), {
      cwd: tmpDir,
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session,
      cwd: tmpDir,
      systemPrompt: await buildAgentSystemPrompt({ cwd: tmpDir }),
    });
    await agent.run("hi");
    expect(session.messages[0]?.role).toBe("system");
    const text = session.messages[0]?.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toContain("Always use tests.");
  });

  it("plan mode still yields a PLAN MODE system message (regression)", async () => {
    const model = new FakeModel([textResponse("ok")]);
    const session = new InMemorySession(newSessionId(), {
      cwd: tmpDir,
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session,
      cwd: tmpDir,
      systemPrompt: await buildAgentSystemPrompt({ cwd: tmpDir, plan: true }),
    });
    await agent.run("hi");
    const text = session.messages[0]?.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toContain("PLAN MODE");
  });
});
