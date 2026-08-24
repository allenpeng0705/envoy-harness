import { describe, expect, it } from "vitest";

import { applyShellEnvironmentPolicy } from "../../src/config/shell-env.js";
import { mergeConfigLayers } from "../../src/config/layers.js";
import { resolveAgentRuntimeConfig } from "../../src/config/apply.js";
import { buildAgentSystemPrompt } from "../../src/system-prompt/wire.js";
import { assembleTurnContext } from "../../src/context/turn-context.js";
import { createSkillRegistry } from "../../src/skills/registry.js";
import type { SkillProvider, SkillSummary } from "../../src/skills/types.js";

describe("applyShellEnvironmentPolicy", () => {
  it("inherits all by default and drops secret-ish keys", () => {
    const env = applyShellEnvironmentPolicy(undefined, {
      PATH: "/bin",
      OPENAI_API_KEY: "sk-secret",
      HOME: "/home/u",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("supports inherit=core and set overrides", () => {
    const env = applyShellEnvironmentPolicy(
      { inherit: "core", set: { FOO: "bar" } },
      {
        PATH: "/bin",
        HOME: "/home/u",
        EXTRA: "x",
      },
    );
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.EXTRA).toBeUndefined();
    expect(env.FOO).toBe("bar");
  });
});

describe("mergeConfigLayers + resolveAgentRuntimeConfig", () => {
  it("lets later layers win and builds sandbox policy", () => {
    const layer = mergeConfigLayers(
      { permissionMode: "read-only" },
      { permissionMode: "workspace-write", networkAccess: true },
    );
    expect(layer.permissionMode).toBe("workspace-write");
    const runtime = resolveAgentRuntimeConfig("/tmp/proj", layer);
    expect(runtime.permissionMode).toBe("workspace-write");
    expect(runtime.sandboxPolicy.networkAccess).toBe(true);
  });
});

describe("buildAgentSystemPrompt sections", () => {
  it("includes identity, permissions, and tool guidance", async () => {
    const prompt = await buildAgentSystemPrompt({
      cwd: process.cwd(),
      persona: "Be terse.",
      permissionMode: "read-only",
      askForApproval: "on-request",
    });
    expect(prompt).toContain("Envoy Harness");
    expect(prompt).toContain("Be terse.");
    expect(prompt).toContain("permission mode `read-only`");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("<environment_context>");
  });
});

describe("assembleTurnContext", () => {
  it("injects skill catalog when skills change", async () => {
    const provider: SkillProvider = {
      name: "test",
      async list() {
        const summaries: SkillSummary[] = [
          {
            name: "demo",
            description: "A demo skill",
            provider: "test",
            invocation: { modelInvocable: true, userInvocable: true },
          },
        ];
        return summaries;
      },
      async get() {
        return undefined;
      },
    };
    const skills = createSkillRegistry();
    skills.registerProvider(provider);
    const first = await assembleTurnContext({
      cwd: process.cwd(),
      signal: new AbortController().signal,
      skills,
    });
    expect(first.text).toContain("<available_skills>");
    expect(first.skillCatalogDigest).toBeTruthy();
    const second = await assembleTurnContext({
      cwd: process.cwd(),
      signal: new AbortController().signal,
      skills,
      ...(first.skillCatalogDigest !== undefined
        ? { skillCatalogDigest: first.skillCatalogDigest }
        : {}),
    });
    expect(second.text).toBe("");
    expect(second.skillCatalogDigest).toBe(first.skillCatalogDigest);
  });
});
