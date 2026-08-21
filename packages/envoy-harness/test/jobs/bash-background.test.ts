/**
 * Phase C — bash --job sugar + environment wire (hermetic).
 */

import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { InMemorySession, newSessionId } from "../../src/session.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { bashTool, makeBashTool } from "../../src/tools/builtin/bash.js";
import { createLocalJobRegistry } from "../../src/jobs/index.js";
import { wireEnvironmentTools } from "../../src/environment/wire.js";
import { BUILTIN_TOOLS } from "../../src/tools/builtin/index.js";

function ctx(cwd: string) {
  return {
    cwd,
    session: new InMemorySession(newSessionId(), {
      cwd,
      startedAt: new Date().toISOString(),
      permissionMode: "danger-full-access",
    }),
    abortSignal: AbortSignal.timeout(10_000),
  };
}

describe("makeBashTool background", () => {
  it("default bashTool has no jobs (background errors)", async () => {
    const result = await bashTool.execute(
      { command: "echo hi", background: true },
      ctx(process.cwd()),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/job registry/);
  });

  it("background: true returns a job id immediately", async () => {
    const jobs = createLocalJobRegistry();
    const tool = makeBashTool({ jobs });
    const c = ctx(process.cwd());
    const result = await tool.execute(
      { command: "echo hello-bg", background: true },
      c,
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(String(result.content)) as { id: string; status: string };
    expect(parsed.id).toMatch(/^bash-/);
    expect(parsed.status).toBe("running");
    await jobs.wait(parsed.id, 5_000, c.session.id);
    await jobs.dispose();
  });
});

describe("wireEnvironmentTools", () => {
  it("returns credentials and re-registers bash with jobs", async () => {
    const tools = new ToolRegistry();
    for (const t of BUILTIN_TOOLS) tools.register(t);
    const env = wireEnvironmentTools(tools, { preferPty: false });
    expect(env.credentials).toBeDefined();
    expect(env.jobs).toBeDefined();
    expect(tools.has("bash")).toBe(true);
    expect(tools.has("job_start")).toBe(true);

    const c = ctx(process.cwd());
    const bash = tools.get("bash")!;
    const result = await bash.execute(
      { command: "true", background: true },
      c,
    );
    expect(result.isError).toBeFalsy();
    await env.dispose();
  });

  it("registers brave when BRAVE_SEARCH_API_KEY is in env", async () => {
    const prev = process.env["BRAVE_SEARCH_API_KEY"];
    process.env["BRAVE_SEARCH_API_KEY"] = "wire-test-key";
    try {
      const tools = new ToolRegistry();
      for (const t of BUILTIN_TOOLS) tools.register(t);
      const env = wireEnvironmentTools(tools, { preferPty: false });
      // Provider is registered; search tools exist. Do not hit the network.
      expect(tools.has("web_search")).toBe(true);
      expect(env.credentials).toBeDefined();
      await env.dispose();
    } finally {
      if (prev === undefined) delete process.env["BRAVE_SEARCH_API_KEY"];
      else process.env["BRAVE_SEARCH_API_KEY"] = prev;
    }
  });

  it("accepts an explicit credentials file path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wire-creds-"));
    const filePath = path.join(dir, "credentials.json");
    await writeFile(filePath, JSON.stringify({ BRAVE_SEARCH_API_KEY: "from-file" }));
    if (process.platform !== "win32") await chmod(filePath, 0o600);

    const tools = new ToolRegistry();
    for (const t of BUILTIN_TOOLS) tools.register(t);
    const env = wireEnvironmentTools(tools, {
      preferPty: false,
      credentialsFilePath: filePath,
    });
    const value = await env.credentials.resolve(
      { name: "BRAVE_SEARCH_API_KEY", source: "file" },
      { signal: AbortSignal.timeout(5_000) },
    );
    expect(value).toBe("from-file");
    await env.dispose();
  });
});
