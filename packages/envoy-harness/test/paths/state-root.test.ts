import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  canCreateDirectory,
  migrateStateRootInto,
  resolveFallbackEnvoyStateRoot,
  resolvePreferredEnvoyStateRoot,
  resolveWritableEnvoyStateRoot,
  resolveXdgStateHome,
  STATE_MIGRATE_MARKER,
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

  it("migrates sessions from an unwritable preferred root into the fallback", () => {
    const root = scratch();
    const blocked = path.join(root, "blocked-state");
    fs.mkdirSync(blocked, { recursive: true });
    const preferred = path.join(blocked, "envoy-harness");
    const sessions = path.join(preferred, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "old.jsonl"), '{"_kind":"header"}\n');
    fs.writeFileSync(path.join(preferred, "history"), "ls\n");
    fs.writeFileSync(
      path.join(preferred, "trusted-projects.json"),
      '["/p"]\n',
    );
    // Preferred stays readable but not writable (cannot create new sessions).
    fs.chmodSync(preferred, 0o555);
    fs.chmodSync(blocked, 0o555);

    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const env = { XDG_STATE_HOME: blocked, HOME: home };

    try {
      const dest = resolveWritableEnvoyStateRoot(env, () => home);
      expect(dest).toBe(path.join(home, ".envoy-harness"));
      expect(fs.existsSync(path.join(dest, "sessions", "old.jsonl"))).toBe(
        true,
      );
      expect(fs.readFileSync(path.join(dest, "history"), "utf8")).toBe("ls\n");
      expect(
        fs.readFileSync(path.join(dest, "trusted-projects.json"), "utf8"),
      ).toBe('["/p"]\n');
      expect(fs.existsSync(path.join(dest, STATE_MIGRATE_MARKER))).toBe(true);
    } finally {
      fs.chmodSync(preferred, 0o755);
      fs.chmodSync(blocked, 0o755);
    }
  });
});

describe("migrateStateRootInto", () => {
  it("does not overwrite existing destination files", () => {
    const root = scratch();
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    fs.mkdirSync(path.join(src, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(dest, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(src, "sessions", "a.jsonl"), "from-src\n");
    fs.writeFileSync(path.join(dest, "sessions", "a.jsonl"), "keep-dest\n");
    migrateStateRootInto(dest, [src]);
    expect(fs.readFileSync(path.join(dest, "sessions", "a.jsonl"), "utf8")).toBe(
      "keep-dest\n",
    );
  });
});
