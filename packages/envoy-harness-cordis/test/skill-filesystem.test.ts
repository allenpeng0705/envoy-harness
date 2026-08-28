/**
 * C3 — host the deepseek `skill-filesystem` provider and prove parity
 * with envoy-harness's native SKILL.md loader over the same fixture.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFilesystemSkillProvider,
  type SandboxPolicy,
} from "@envoymesh/envoy-harness";
import {
  createCordisContainer,
  EnvoyFileSystem,
} from "../src/index.js";

const SKILL_MD = `---
name: fixture-skill
description: A fixture skill for the cordis compat spike.
---

# Fixture skill

Body text.
`;

let tmpDir: string;
let skillDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cordis-skills-"));
  skillDir = path.join(tmpDir, "skills", "fixture-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), SKILL_MD);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("hosted dsh skill-filesystem", () => {
  it("discovers + loads a SKILL.md from a custom root via ctx.skills", async () => {
    const container = await createCordisContainer({
      plugins: [
        {
          name: "skill-filesystem",
          config: {
            includeDefaultRoots: false,
            customSkillDirs: [path.join(tmpDir, "skills")],
            watch: false,
          },
        },
      ],
    });

    expect(container.status()[0]).toMatchObject({
      name: "skill-filesystem",
      state: "applied",
    });

    const summary = (await container.ctx.skills.list({ cwd: tmpDir })).find(
      (s: { name: string }) => s.name === "fixture-skill",
    );
    expect(summary).toBeDefined();
    expect(summary?.description).toContain("fixture skill");

    const def = await container.ctx.skills.get("fixture-skill", {
      cwd: tmpDir,
    });
    if (def === undefined) throw new Error("expected fixture-skill to load");
    expect(def.content).toContain("Body text");

    await container.dispose();
  });

  it("matches envoy's native SKILL.md loader over the same fixture", async () => {
    // Hosted (deepseek Cordis plugin).
    const container = await createCordisContainer({
      plugins: [
        {
          name: "skill-filesystem",
          config: {
            includeDefaultRoots: false,
            customSkillDirs: [path.join(tmpDir, "skills")],
            watch: false,
          },
        },
      ],
    });
    const hosted = await container.ctx.skills.list({ cwd: tmpDir });

    // Native (envoy L3 SKILL.md loader).
    const native = createFilesystemSkillProvider({
      extraRoots: [{ name: "fixture", path: path.join(tmpDir, "skills") }],
    });
    const nativeList = await native.list({ cwd: tmpDir, signal: new AbortController().signal });

    const hostedSkill = hosted.find((s: { name: string }) => s.name === "fixture-skill");
    const nativeSkill = nativeList.find((s: { name: string }) => s.name === "fixture-skill");
    expect(hostedSkill).toBeDefined();
    expect(nativeSkill).toBeDefined();
    expect(hostedSkill?.description).toBe(nativeSkill?.description);

    await container.dispose();
  });

  it("works over the sandbox-gated envoy fs adapter (C2)", async () => {
    const policy: SandboxPolicy = {
      mode: "workspace-write",
      approval: "on-request",
      backend: "none",
      writableRoots: [tmpDir],
      networkAccess: false,
      slashTmpWritable: true,
    };
    const container = await createCordisContainer({
      services: [
        {
          name: "fs",
          module: EnvoyFileSystem,
          config: { policy, cwd: tmpDir },
        },
      ],
      plugins: [
        {
          name: "skill-filesystem",
          config: {
            includeDefaultRoots: false,
            customSkillDirs: [path.join(tmpDir, "skills")],
            watch: false,
          },
        },
      ],
    });

    const summary = (await container.ctx.skills.list({ cwd: tmpDir })).find(
      (s: { name: string }) => s.name === "fixture-skill",
    );
    expect(summary).toBeDefined();
    expect(summary?.description).toContain("fixture skill");

    await container.dispose();
  });
});
