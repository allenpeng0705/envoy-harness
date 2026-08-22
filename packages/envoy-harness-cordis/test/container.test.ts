/**
 * C1 tests — the general Cordis container: whitelist resolution,
 * dependency-order service application, error isolation, status
 * snapshots, and ordered dispose.
 */

import { describe, expect, it } from "vitest";

import {
  createCordisContainer,
  resolvePluginManifest,
} from "../src/index.js";

describe("createCordisContainer", () => {
  it("reports the hosted capability surface (C4)", async () => {
    const container = await createCordisContainer({
      plugins: [
        { name: "jobs-local" },
        { name: "skill-filesystem" },
        { name: "credentials-local", config: { watch: false } },
      ],
    });
    const caps = container.capabilities();
    expect(caps.find((c) => c.service === "jobs")).toMatchObject({
      provider: "jobs-local",
    });
    expect(caps.find((c) => c.service === "credentials")).toMatchObject({
      provider: "credentials-local",
    });
    expect(caps.find((c) => c.service === "skills")).toBeDefined();
    expect(caps.find((c) => c.service === "fs")).toBeDefined();
    await container.dispose();
  });

  it("hosts jobs-local from config with an applied status", async () => {
    const container = await createCordisContainer({
      plugins: [
        { name: "jobs-local", config: { maxConcurrentJobsPerOwner: 5 } },
      ],
    });
    expect(typeof container.ctx.jobs.start).toBe("function");
    expect(container.status()).toEqual([
      { name: "jobs-local", state: "applied", order: 0 },
    ]);
    await container.dispose();
  });

  it("rejects names outside the whitelist", async () => {
    expect(() =>
      resolvePluginManifest("not-a-real-plugin"),
    ).toThrow(/not in whitelist/);
  });

  it("continues after a failing plugin and records the failure", async () => {
    // An unknown plugin name fails the boot of THAT entry without
    // rejecting the container; the configured valid plugin still applies.
    const container = await createCordisContainer({
      plugins: [
        { name: "jobs-local" },
        { name: "this-does-not-exist" },
      ],
    });
    const statuses = container.status();
    expect(statuses[0]).toMatchObject({ name: "jobs-local", state: "applied" });
    expect(statuses[1]).toMatchObject({ name: "this-does-not-exist", state: "failed" });
    expect(statuses[1]?.error).toContain("not in whitelist");
    // The healthy plugin still works.
    let resolveDone: (o: { status: "killed" }) => void = () => {};
    const done = new Promise<{ status: "killed" }>((r) => {
      resolveDone = r;
    });
    const id = container.ctx.jobs.start({
      kind: "bash",
      label: "still works",
      run: () => ({
        cancel() {
          resolveDone({ status: "killed" });
        },
        done,
      }),
    });
    expect(container.ctx.jobs.get(id).status).toBe("running");
    await container.dispose();
  });
});
