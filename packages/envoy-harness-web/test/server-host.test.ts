/**
 * The non-loopback warning is the safety net for the project registry: the
 * API can add any absolute directory, which is right for the operator at
 * this machine and needs a bound once anyone else can reach the port.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultWebAcpCwd,
  newestClientSourceMtime,
  shouldPreferViteDev,
  withHarnessCwd,
} from "../src/server/start.js";
import { isLoopbackHost } from "../src/server/host.js";
import { resolveTsxImportSpecifier } from "../src/server/spawn.js";

describe("isLoopbackHost", () => {
  it("accepts the loopback forms", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("rejects anything reachable from elsewhere", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("does not treat a lookalike prefix as loopback", () => {
    // 127.0.0.1.evil.com must not pass a naive startsWith check that is not
    // anchored on the "127." label boundary.
    expect(isLoopbackHost("2127.0.0.1")).toBe(false);
    expect(isLoopbackHost("1270.0.0.1")).toBe(false);
  });
});

describe("shouldPreferViteDev", () => {
  it("prefers Vite when dist/client is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-web-dist-"));
    expect(shouldPreferViteDev(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prefers Vite when any client source is newer than dist index.html", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-web-dist-"));
    const index = path.join(dir, "index.html");
    fs.writeFileSync(index, "<html></html>");
    const past = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(index, past, past);
    const pkgRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const newest = newestClientSourceMtime(
      path.join(pkgRoot, "src/client"),
    );
    expect(newest).toBeGreaterThan(past.getTime());
    expect(shouldPreferViteDev(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("tracks nested client sources, not only App.tsx", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eh-web-src-"));
    const nested = path.join(root, "acp");
    fs.mkdirSync(nested, { recursive: true });
    const old = path.join(root, "App.tsx");
    const young = path.join(nested, "host.ts");
    fs.writeFileSync(old, "export {}\n");
    fs.writeFileSync(young, "export {}\n");
    const past = new Date("2020-01-01T00:00:00Z");
    const future = new Date("2035-01-01T00:00:00Z");
    fs.utimesSync(old, past, past);
    fs.utimesSync(young, future, future);
    expect(newestClientSourceMtime(root)).toBe(future.getTime());
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("withHarnessCwd / tsx resolve", () => {
  it("injects --cwd when missing", () => {
    expect(withHarnessCwd(["--persist"], "/tmp/scratch")).toEqual([
      "--cwd",
      "/tmp/scratch",
      "--persist",
    ]);
  });

  it("does not duplicate an existing --cwd", () => {
    expect(withHarnessCwd(["--cwd", "/x", "--persist"], "/tmp/scratch")).toEqual(
      ["--cwd", "/x", "--persist"],
    );
  });

  it("resolves an absolute tsx loader", () => {
    const spec = resolveTsxImportSpecifier();
    expect(path.isAbsolute(spec)).toBe(true);
    expect(fs.existsSync(spec)).toBe(true);
  });

  it("creates the default scratch session cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eh-home-"));
    const scratch = defaultWebAcpCwd(() => root);
    expect(scratch).toBe(path.join(root, ".envoy-harness", "scratch"));
    expect(fs.existsSync(scratch)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
