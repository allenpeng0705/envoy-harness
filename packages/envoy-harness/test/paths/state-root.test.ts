import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  canCreateDirectory,
  resolveFallbackEnvoyStateRoot,
  resolvePreferredEnvoyStateRoot,
  resolveWritableEnvoyStateRoot,
  resolveXdgStateHome,
} from "../../src/paths/state-root.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envoy-state-root-"));
  scratchDirs.push(dir);
  return dir;
}

describe("resolveXdgStateHome", () => {
  it("prefers XDG_STATE_HOME", () => {
    expect(
      resolveXdgStateHome({ XDG_STATE_HOME: "/xdg/state", HOME: "/home/u" }),
    ).toBe("/xdg/state");
  });

  it("uses LOCALAPPDATA when XDG is unset", () => {
    expect(
      resolveXdgStateHome({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }),
    ).toBe("C:\\Users\\u\\AppData\\Local");
  });

  it("falls back to ~/.local/state", () => {
    expect(resolveXdgStateHome({ HOME: "/home/u" }, () => "/home/u")).toBe(
      path.join("/home/u", ".local", "state"),
    );
  });
});

describe("resolveWritableEnvoyStateRoot", () => {
  it("uses the preferred XDG path when creatable", () => {
    const root = scratch();
    const env = { XDG_STATE_HOME: root, HOME: root };
    const preferred = resolvePreferredEnvoyStateRoot(env, () => root);
    expect(canCreateDirectory(preferred)).toBe(true);
    expect(resolveWritableEnvoyStateRoot(env, () => root)).toBe(preferred);
  });

  it("falls back to ~/.envoy-harness when preferred parent is not writable", () => {
    const root = scratch();
    const blocked = path.join(root, "blocked-state");
    fs.mkdirSync(blocked, { recursive: true });
    fs.chmodSync(blocked, 0o555);

    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const env = { XDG_STATE_HOME: blocked, HOME: home };

    try {
      expect(resolveWritableEnvoyStateRoot(env, () => home)).toBe(
        resolveFallbackEnvoyStateRoot(env, () => home),
      );
    } finally {
      fs.chmodSync(blocked, 0o755);
    }
  });
});
