/**
 * C4 tests — hosted dsh capabilities bridged into envoy's native
 * registries, so envoy's own tools can consume deepseek plugins.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSkillRegistry,
  type JobHooks as EnvoyJobHooks,
  type JobOutcome as EnvoyJobOutcome,
} from "@envoymesh/envoy-harness";
import {
  createCordisContainer,
  createHostedJobsRegistry,
  createHostedSkillsProvider,
} from "../src/index.js";

let tmpDir: string;
let skillDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cordis-bridge-"));
  skillDir = path.join(tmpDir, "skills", "fixture-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: A fixture skill.\n---\n\nBody text\n",
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createHostedSkillsProvider (C4)", () => {
  it("serves deepseek-hosted skills through envoy's skill registry", async () => {
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

    const envoySkills = createSkillRegistry();
    envoySkills.registerProvider(
      createHostedSkillsProvider(container.ctx),
    );
    const summaries = await envoySkills.list({
      cwd: tmpDir,
      signal: new AbortController().signal,
    });
    expect(summaries.find((s) => s.name === "fixture-skill")).toBeDefined();

    const def = await envoySkills.get("fixture-skill", {
      cwd: tmpDir,
      signal: new AbortController().signal,
    });
    if (def === undefined) throw new Error("expected fixture-skill via bridge");
    expect(def.instructions).toContain("Body text");

    await container.dispose();
  });
});

describe("createHostedJobsRegistry (C4)", () => {
  function fakeProducer(delayMs = 3): EnvoyJobHooks {
    let resolveDone: (o: EnvoyJobOutcome) => void = () => {};
    const done = new Promise<EnvoyJobOutcome>((r) => {
      resolveDone = r;
    });
    const timer = setTimeout(
      () => resolveDone({ status: "completed", detail: "fake" }),
      delayMs,
    );
    return {
      cancel(reason?: string) {
        clearTimeout(timer);
        resolveDone({
          status: "killed",
          ...(reason !== undefined ? { detail: reason } : {}),
        });
      },
      done,
    };
  }

  it("drives deepseek-hosted jobs through envoy's JobRegistry shape", async () => {
    const container = await createCordisContainer({
      plugins: [{ name: "jobs-local" }],
    });
    const bridge = createHostedJobsRegistry(container.ctx);

    const id = bridge.start({
      kind: "bash",
      label: "bridge job",
      owner: "owner-1",
      run: () => fakeProducer(),
    });
    expect(bridge.get(id, "owner-1").status).toBe("running");

    const settled = await bridge.wait(id, 2_000, "owner-1");
    expect(settled.status).toBe("completed");

    // disposeOwner kills owned jobs (here: a second, long-running one).
    let resolveLong: (o: EnvoyJobOutcome) => void = () => {};
    const longDone = new Promise<EnvoyJobOutcome>((r) => {
      resolveLong = r;
    });
    const longId = bridge.start({
      kind: "bash",
      label: "long job",
      owner: "owner-1",
      run: () => ({
        cancel() {
          resolveLong({ status: "killed" });
        },
        done: longDone,
      }),
    });
    await bridge.disposeOwner("owner-1");
    expect(bridge.get(longId).status).toBe("killed");

    await container.dispose();
  });
});
