/**
 * Cordis optional wire-up from config.
 */

import { describe, expect, it } from "vitest";

import { ToolRegistry, wireEnvironmentTools } from "../../src/index.js";
import {
  wireCordisExtensions,
  wireCordisFromConfig,
} from "../../src/cordis/wire-from-config.js";

describe("wireCordisFromConfig", () => {
  it("returns undefined for an empty plugin list", async () => {
    const tools = new ToolRegistry();
    const env = wireEnvironmentTools(tools, { preferPty: false });
    const result = await wireCordisFromConfig({
      plugins: [],
      cwd: "/tmp",
      tools,
      jobs: env.jobs,
      skills: env.skills,
      web: env.web,
    });
    expect(result).toBeUndefined();
    await env.dispose();
  });
});

describe("wireCordisExtensions with jobs-local", () => {
  it("bridges hosted jobs when envoy-harness-cordis is installed", async () => {
    const tools = new ToolRegistry();
    const env = wireEnvironmentTools(tools, { preferPty: false });
    const wired = await wireCordisExtensions({
      plugins: [{ name: "jobs-local" }],
      cwd: "/tmp",
      tools,
      environment: env,
    });
  // When the optional package is missing, wire returns the default jobs registry.
    if (wired.cordisDispose === undefined) {
      expect(wired.jobs).toBe(env.jobs);
      await env.dispose();
      return;
    }
    expect(wired.jobs).not.toBe(env.jobs);
    await wired.cordisDispose?.();
    await env.dispose();
  });
});
