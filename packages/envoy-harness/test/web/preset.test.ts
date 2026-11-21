/**
 * Webdev permission preset expands network + frontend/Playwright roots.
 */

import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAgentRuntimeConfig } from "../../src/config/apply.js";
import {
  isWebBrowserAccessAllowed,
  resolvePermissionPreset,
  webdevWritableRoots,
} from "../../src/permissions/index.js";

describe("webdev permission preset", () => {
  it("resolves axes + network + expandWebdevRoots", () => {
    const preset = resolvePermissionPreset("webdev");
    expect(preset.permissionMode).toBe("workspace-write");
    expect(preset.askForApproval).toBe("on-request");
    expect(preset.autoRun).toBe("safe-only");
    expect(preset.networkAccess).toBe(true);
    expect(preset.expandWebdevRoots).toBe(true);
  });

  it("resolveAgentRuntimeConfig expands roots and network", () => {
    const cwd = "/tmp/spa";
    const resolved = resolveAgentRuntimeConfig(cwd, {
      permissionPreset: "webdev",
    });
    expect(resolved.permissionMode).toBe("workspace-write");
    expect(resolved.sandboxPolicy.networkAccess).toBe(true);
    const roots = resolved.sandboxPolicy.writableRoots;
    expect(roots.some((r) => r === path.join(cwd, ".next"))).toBe(true);
    expect(
      roots.some((r) => r === path.join(cwd, "node_modules", ".vite")),
    ).toBe(true);
    expect(isWebBrowserAccessAllowed(resolved.sandboxPolicy)).toBe(true);
  });

  it("webdevWritableRoots includes ms-playwright under cache", () => {
    const roots = webdevWritableRoots({
      cwd: "/tmp/p",
      homeDir: os.homedir(),
    });
    expect(roots.some((r) => r.includes("ms-playwright"))).toBe(true);
  });

  it("does not treat bare cwd / dist / test-results as webdev", async () => {
    const { isWebdevWritableRoot, isWebBrowserAccessAllowed } = await import(
      "../../src/permissions/webdev-roots.js"
    );
    expect(isWebdevWritableRoot("/Users/dev/spa")).toBe(false);
    expect(isWebdevWritableRoot("/Users/dev/build")).toBe(false);
    // Bare …/dist must not unlock browser_* (Rust/Python/etc. projects).
    expect(isWebdevWritableRoot("/Users/dev/crate/dist")).toBe(false);
    expect(isWebdevWritableRoot("/tmp/app/test-results")).toBe(false);
    expect(
      isWebBrowserAccessAllowed({
        mode: "workspace-write",
        networkAccess: false,
        writableRoots: ["/Users/dev/spa", "/Users/dev/crate/dist"],
      }),
    ).toBe(false);
    expect(isWebdevWritableRoot("/tmp/app/.next")).toBe(true);
    expect(isWebdevWritableRoot("/tmp/app/.output")).toBe(true);
    expect(isWebdevWritableRoot("/tmp/app/node_modules/.vite")).toBe(true);
    expect(isWebdevWritableRoot("/home/u/.cache/ms-playwright")).toBe(true);
  });
});
