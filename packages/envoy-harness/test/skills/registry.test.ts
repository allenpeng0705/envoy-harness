/**
 * Skill registry + tool tests.
 */

import { describe, expect, it } from "vitest";

import {
  createSkillRegistry,
  makeSkillListTool,
  makeSkillTool,
  type SkillDefinition,
  type SkillProvider,
} from "../../src/skills/index.js";
import type { ToolContext } from "../../src/tools/types.js";

function fakeContext(): ToolContext {
  // ToolContext has just the fields the tools actually use.
  // We only need cwd + abortSignal for the skill tools.
  return {
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    session: { id: "s1", metadata: { cwd: process.cwd(), startedAt: new Date().toISOString() } } as never,
  };
}

const skill: SkillDefinition = {
  name: "deploy",
  description: "Deploy the service.",
  provider: "test",
  invocation: { modelInvocable: true, userInvocable: true },
  resourceBase: "/test",
  instructions: "Step 1: ship.",
};

function fakeProvider(s: SkillDefinition | undefined): SkillProvider {
  return {
    name: "fake",
    async list() {
      return s
        ? [
            {
              name: s.name,
              description: s.description,
              provider: s.provider,
              invocation: s.invocation,
            },
          ]
        : [];
    },
    async get() {
      return s;
    },
  };
}

describe("createSkillRegistry", () => {
  it("merges results across providers (last provider wins on name conflict)", async () => {
    const a = fakeProvider({ ...skill, description: "from A" });
    const b = fakeProvider({ ...skill, description: "from B" });
    const r = createSkillRegistry();
    r.registerProvider(a);
    r.registerProvider(b);
    const list = await r.list({
      cwd: "/x",
      signal: new AbortController().signal,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.description).toBe("from B");
  });

  it("returns first provider's definition on get()", async () => {
    const a = fakeProvider({ ...skill, instructions: "from A" });
    const b = fakeProvider({ ...skill, instructions: "from B" });
    const r = createSkillRegistry();
    r.registerProvider(a);
    r.registerProvider(b);
    const def = await r.get("deploy", {
      cwd: "/x",
      signal: new AbortController().signal,
    });
    expect(def?.instructions).toBe("from A");
  });

  it("isolates a provider that throws", async () => {
    const throws: SkillProvider = {
      name: "bad",
      async list() {
        throw new Error("boom");
      },
      async get() {
        throw new Error("boom");
      },
    };
    const ok = fakeProvider(skill);
    const r = createSkillRegistry();
    r.registerProvider(throws);
    r.registerProvider(ok);
    const list = await r.list({
      cwd: "/x",
      signal: new AbortController().signal,
    });
    expect(list).toHaveLength(1);
  });

  it("unregisters via the returned dispose function", async () => {
    const r = createSkillRegistry();
    const dispose = r.registerProvider(fakeProvider(skill));
    expect(r.providers()).toEqual(["fake"]);
    dispose();
    expect(r.providers()).toEqual([]);
  });
});

describe("skill tool", () => {
  it("returns the canonical <skill_content> block", async () => {
    const r = createSkillRegistry();
    r.registerProvider(fakeProvider(skill));
    const tool = makeSkillTool(r);
    const result = await tool.execute(
      { name: "deploy" },
      fakeContext(),
    );
    expect(result.content).toContain("<skill_content>");
    expect(result.content).toContain("<name>deploy</name>");
    expect(result.isError).not.toBe(true);
  });

  it("returns isError for an unknown skill", async () => {
    const r = createSkillRegistry();
    r.registerProvider(fakeProvider(undefined));
    const tool = makeSkillTool(r);
    const result = await tool.execute({ name: "nope" }, fakeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/unknown skill/);
  });
});

describe("skill_list tool", () => {
  it("returns the catalog projection (<available_skills>)", async () => {
    const r = createSkillRegistry();
    r.registerProvider(fakeProvider(skill));
    r.registerProvider(
      fakeProvider({
        ...skill,
        name: "other",
        description: "Another skill.",
      }),
    );
    const tool = makeSkillListTool(r);
    const result = await tool.execute({}, fakeContext());
    const text = result.content as string;
    expect(text).toContain("<available_skills>");
    expect(text).toContain('name="deploy"');
    expect(text).toContain('name="other"');
    expect(text).toContain("</available_skills>");
  });
});
