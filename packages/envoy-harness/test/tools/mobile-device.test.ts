/**
 * Mobile device_* tools — arg validation + mocked host CLIs.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  deviceBootTool,
  deviceListTool,
  deviceScreenshotTool,
  setHostCommandRunner,
  type HostCommandResult,
} from "../../src/tools/builtin/mobile/index.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { Session } from "../../src/session.js";

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: "/tmp/proj",
    session: { id: "s" } as Session,
    abortSignal: new AbortController().signal,
    sandboxPolicy: {
      mode: "workspace-write",
      approval: "on-request",
      backend: "none",
      writableRoots: ["/tmp/proj", "/Users/x/Library/Developer/CoreSimulator"],
      networkAccess: true,
      slashTmpWritable: true,
    },
    ...overrides,
  };
}

afterEach(() => {
  setHostCommandRunner(undefined);
});

describe("device_* gate", () => {
  it("refuses without mobile roots / env", async () => {
    const result = await deviceListTool.execute({}, {
      ...ctx(),
      sandboxPolicy: {
        mode: "workspace-write",
        approval: "on-request",
        backend: "none",
        writableRoots: ["/tmp/proj"],
        networkAccess: false,
        slashTmpWritable: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("permission-preset mobile");
  });
});

describe("device_list", () => {
  it("merges simctl + adb output", async () => {
    setHostCommandRunner(async (argv): Promise<HostCommandResult> => {
      if (argv.includes("simctl")) {
        return {
          code: 0,
          stdout: JSON.stringify({ devices: { "iOS 18": [] } }),
          stderr: "",
        };
      }
      if (argv[0] === "adb") {
        return { code: 0, stdout: "List of devices\nemulator-5554 device\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
    });
    const result = await deviceListTool.execute({}, ctx());
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("iOS simulators");
    expect(String(result.content)).toContain("emulator-5554");
  });
});

describe("device_boot", () => {
  it("boots ios and waits", async () => {
    const calls: string[] = [];
    setHostCommandRunner(async (argv): Promise<HostCommandResult> => {
      calls.push(argv.join(" "));
      return { code: 0, stdout: "ok", stderr: "" };
    });
    const result = await deviceBootTool.execute(
      { platform: "ios", device_id: "UDID-1", action: "boot" },
      ctx(),
    );
    expect(result.isError).toBeUndefined();
    expect(calls.some((c) => c.includes("simctl boot"))).toBe(true);
    expect(calls.some((c) => c.includes("bootstatus"))).toBe(true);
  });

  it("boots android AVD detached and waits on new serial + boot_completed", async () => {
    const { deviceBootTool: bootTool } = await import(
      "../../src/tools/builtin/mobile/index.js"
    );
    let devicesPhase = 0;
    const calls: string[] = [];
    setHostCommandRunner(async (argv, opts): Promise<HostCommandResult> => {
      calls.push(argv.join(" "));
      if (argv[0] === "emulator") {
        expect(opts?.detach).toBe(true);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "adb" && argv[1] === "devices") {
        devicesPhase += 1;
        if (devicesPhase === 1) {
          return { code: 0, stdout: "List of devices attached\n", stderr: "" };
        }
        return {
          code: 0,
          stdout: "List of devices attached\nemulator-5554\tdevice\n",
          stderr: "",
        };
      }
      if (argv.includes("wait-for-device")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv.includes("sys.boot_completed")) {
        return { code: 0, stdout: "1\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await bootTool.execute(
      { platform: "android", device_id: "Pixel_8_API_35", action: "boot" },
      ctx(),
    );
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("emulator-5554");
    expect(calls.some((c) => c.includes("emulator -avd"))).toBe(true);
    expect(calls.some((c) => c.includes("wait-for-device"))).toBe(true);
    expect(calls.some((c) => c.includes("sys.boot_completed"))).toBe(true);
  });
});

describe("device_screenshot", () => {
  it("returns multimodal png content", async () => {
    const { promises: fs } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    // Capture whatever path simctl is asked to write, then seed a tiny PNG.
    setHostCommandRunner(async (argv): Promise<HostCommandResult> => {
      const out = argv[argv.length - 1]!;
      await fs.mkdir(path.dirname(out), { recursive: true });
      // Minimal 1x1 PNG
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      await fs.writeFile(out, png);
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await deviceScreenshotTool.execute(
      { platform: "ios", device_id: "UDID-1" },
      ctx(),
    );
    expect(result.isError).toBeUndefined();
    const content = result.content as { text: string; images: Array<{ mimeType: string; data: string }> };
    expect(content.images[0]?.mimeType).toBe("image/png");
    expect(content.images[0]?.data.length).toBeGreaterThan(10);
    void os;
  });
});
