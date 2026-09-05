/**
 * R4.5b — permission presets.
 */

import { describe, expect, it } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  ConfigLayerSchema,
  matchPermissionPreset,
  permissionPresetToConfigFields,
  PERMISSION_PRESETS,
  resolveAgentRuntimeConfig,
  resolvePermissionPreset,
  loadConfigFile,
} from "../../src/index.js";

describe("permission presets", () => {
  it("resolves safe / ask-all / approve-all axes", () => {
    expect(resolvePermissionPreset("safe")).toMatchObject({
      permissionMode: "read-only",
      askForApproval: "unless-trusted",
      autoRun: "always-confirm",
    });
    expect(resolvePermissionPreset("ask-all")).toMatchObject({
      permissionMode: "workspace-write",
      askForApproval: "on-request",
      autoRun: "always-confirm",
    });
    expect(resolvePermissionPreset("approve-all")).toMatchObject({
      permissionMode: "danger-full-access",
      askForApproval: "never",
      autoRun: "off",
    });
    expect(PERMISSION_PRESETS).toHaveLength(3);
  });

  it("matchPermissionPreset round-trips exact axes", () => {
    for (const p of PERMISSION_PRESETS) {
      expect(
        matchPermissionPreset({
          permissionMode: p.permissionMode,
          askForApproval: p.askForApproval,
          autoRun: p.autoRun,
        }),
      ).toBe(p.name);
    }
    expect(
      matchPermissionPreset({
        permissionMode: "workspace-write",
        askForApproval: "never",
        autoRun: "off",
      }),
    ).toBeUndefined();
  });

  it("permissionPresetToConfigFields is stable for config round-trip", () => {
    const fields = permissionPresetToConfigFields("safe");
    const layer = ConfigLayerSchema.parse(fields);
    expect(layer.permissionPreset).toBe("safe");
    expect(layer.permissionMode).toBe("read-only");
    expect(layer.askForApproval).toBe("unless-trusted");
    expect(layer.autoRun).toBe("always-confirm");
  });

  it("resolveAgentRuntimeConfig expands preset", () => {
    const resolved = resolveAgentRuntimeConfig("/tmp/proj", {
      permissionPreset: "safe",
    });
    expect(resolved.permissionMode).toBe("read-only");
    expect(resolved.askForApproval).toBe("unless-trusted");
    expect(resolved.autoRun).toBe("always-confirm");
    expect(resolved.permissionPreset).toBe("safe");
    expect(resolved.sandboxPolicy.mode).toBe("read-only");
  });

  it("explicit layer fields override preset axes", () => {
    const resolved = resolveAgentRuntimeConfig("/tmp/proj", {
      permissionPreset: "safe",
      permissionMode: "workspace-write",
      autoRun: "safe-only",
    });
    expect(resolved.permissionMode).toBe("workspace-write");
    expect(resolved.askForApproval).toBe("unless-trusted"); // from preset
    expect(resolved.autoRun).toBe("safe-only");
  });

  it("loads permission_preset from TOML", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "envoy-preset-"));
    const file = path.join(dir, "config.toml");
    try {
      await writeFile(
        file,
        'permission_preset = "ask-all"\n',
        "utf8",
      );
      const layer = await loadConfigFile(file);
      expect(layer.permissionPreset).toBe("ask-all");
      const parsed = ConfigLayerSchema.parse(layer);
      expect(parsed.permissionPreset).toBe("ask-all");
      const resolved = resolveAgentRuntimeConfig(dir, parsed);
      expect(resolved.permissionMode).toBe("workspace-write");
      expect(resolved.askForApproval).toBe("on-request");
      expect(resolved.autoRun).toBe("always-confirm");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
