/**
 * Optional darwin smoke: list/boot/screenshot against a booted simulator
 * when ENVOY_MOBILE_SMOKE=1 and Xcode tools are present.
 */

import { describe, expect, it } from "vitest";

const enabled = process.env["ENVOY_MOBILE_SMOKE"] === "1";

describe.runIf(enabled && process.platform === "darwin")(
  "mobile smoke (ENVOY_MOBILE_SMOKE=1)",
  () => {
    it("lists simulators via device_list", async () => {
      process.env["ENVOY_MOBILE_TOOLS"] = "1";
      const { deviceListTool } = await import(
        "../../src/tools/builtin/mobile/index.js"
      );
      const result = await deviceListTool.execute(
        { platform: "ios" },
        {
          cwd: process.cwd(),
          session: { id: "smoke" } as never,
          abortSignal: new AbortController().signal,
          sandboxPolicy: {
            mode: "danger-full-access",
            approval: "never",
            backend: "none",
            writableRoots: [],
            networkAccess: true,
            slashTmpWritable: true,
          },
        },
      );
      expect(result.isError).not.toBe(true);
      expect(String(result.content).length).toBeGreaterThan(0);
    });
  },
);
