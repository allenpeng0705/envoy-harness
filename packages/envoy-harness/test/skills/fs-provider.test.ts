/**
 * Filesystem SkillProvider tests.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFilesystemSkillProvider } from "../../src/skills/index.js";

let tmpCwd: string;
let tmpHome: string;

beforeEach(async () => {
  tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "skills-cwd-"));
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "skills-home-"));
});

afterEach(async () => {
  await fs.rm(tmpCwd, { recursive: true, force: true });
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function writeSkill(
  baseDir: string,
  name: string,
  frontmatter: Record<string, string>,
  body: string,
): Promise<void> {
  const dir = path.join(baseDir, name);
  await fs.mkdir(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\n${fm}\n---\n${body}`,
    "utf8",
  );
}

describe("createFilesystemSkillProvider", () => {
  it("lists a skill from the project .envoy/skills/ root", async () => {
    await writeSkill(
      path.join(tmpCwd, ".envoy", "skills"),
      "deploy",
      { name: "deploy", description: "Deploy the service." },
      "Run tests.\nThen tag.",
    );
    const provider = createFilesystemSkillProvider({ homeDir: tmpHome });
    const list = await provider.list({
      cwd: tmpCwd,
      signal: new AbortController().signal,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("deploy");
    expect(list[0]?.description).toBe("Deploy the service.");
    expect(list[0]?.provider).toBe("project:envoy");
  });

  it("reads a skill definition with body + resourceBase", async () => {
    const dir = path.join(tmpCwd, ".envoy", "skills", "deploy");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---
name: deploy
description: Deploy.
---
Step 1: build.
Step 2: ship.`,
      "utf8",
    );
    const provider = createFilesystemSkillProvider({ homeDir: tmpHome });
    const def = await provider.get("deploy", {
      cwd: tmpCwd,
      signal: new AbortController().signal,
    });
    expect(def).toBeDefined();
    expect(def?.instructions).toBe("Step 1: build.\nStep 2: ship.");
    expect(def?.resourceBase).toBe(dir);
  });

  it("project-local wins over user-level for the same name", async () => {
    await writeSkill(
      path.join(tmpCwd, ".envoy", "skills"),
      "deploy",
      { name: "deploy", description: "PROJECT version" },
      "project body",
    );
    await writeSkill(
      path.join(tmpHome, ".agents", "skills"),
      "deploy",
      { name: "deploy", description: "USER version" },
      "user body",
    );
    const provider = createFilesystemSkillProvider({ homeDir: tmpHome });
    const def = await provider.get("deploy", {
      cwd: tmpCwd,
      signal: new AbortController().signal,
    });
    expect(def?.description).toBe("PROJECT version");
  });

  it("scans codex + deepseek + universal roots", async () => {
    await writeSkill(
      path.join(tmpCwd, ".codex", "skills"),
      "codex-skill",
      { name: "codex-skill", description: "from codex" },
      "x",
    );
    await writeSkill(
      path.join(tmpCwd, ".dsh", "skills"),
      "dsh-skill",
      { name: "dsh-skill", description: "from dsh" },
      "x",
    );
    await writeSkill(
      path.join(tmpHome, ".agents", "skills"),
      "universal",
      { name: "universal", description: "from .agents" },
      "x",
    );
    const provider = createFilesystemSkillProvider({ homeDir: tmpHome });
    const list = await provider.list({
      cwd: tmpCwd,
      signal: new AbortController().signal,
    });
    const names = list.map((s) => s.name).sort();
    expect(names).toEqual(["codex-skill", "dsh-skill", "universal"]);
  });

  it("isolates a malformed SKILL.md (one bad skill doesn't kill the catalog)", async () => {
    await writeSkill(
      path.join(tmpCwd, ".envoy", "skills"),
      "good",
      { name: "good", description: "fine" },
      "body",
    );
    // Malformed: missing the closing fence.
    const badDir = path.join(tmpCwd, ".envoy", "skills", "bad");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(
      path.join(badDir, "SKILL.md"),
      `---
name: bad
description: no fence
body body body`,
      "utf8",
    );
    const provider = createFilesystemSkillProvider({ homeDir: tmpHome });
    const list = await provider.list({
      cwd: tmpCwd,
      signal: new AbortController().signal,
    });
    expect(list.map((s) => s.name)).toEqual(["good"]);
  });

  it("returns undefined from get() for an unknown skill", async () => {
    const provider = createFilesystemSkillProvider({ homeDir: tmpHome });
    const def = await provider.get("nonexistent", {
      cwd: tmpCwd,
      signal: new AbortController().signal,
    });
    expect(def).toBeUndefined();
  });

  it("honors an already-aborted signal (returns empty list)", async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = createFilesystemSkillProvider({ homeDir: tmpHome });
    const list = await provider.list({
      cwd: tmpCwd,
      signal: ac.signal,
    });
    expect(list).toEqual([]);
  });
});
