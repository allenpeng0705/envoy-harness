/**
 * device_screenshot — capture PNG and return multimodal vision content.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import type { MultimodalToolContent } from "../../multimodal.js";
import type { Tool, ToolResult } from "../../types.js";
import { runHostCommand } from "./exec.js";
import { requireMobileAccess } from "./gate.js";

const params = z.object({
  platform: z.enum(["ios", "android"]),
  device_id: z.string().min(1),
});

export const deviceScreenshotTool: Tool<typeof params> = {
  name: "device_screenshot",
  timeoutMs: 60_000,
  isConcurrencySafe: () => true,
  description:
    "Capture a PNG screenshot from an iOS Simulator or Android device and " +
    "return it as vision content for the model (multimodal tool result).",
  parameters: params,
  async execute(args, ctx): Promise<ToolResult<MultimodalToolContent | string>> {
    const denied = requireMobileAccess(ctx);
    if (denied) return denied;

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-device-shot-"));
    const outFile = path.join(tmp, "screen.png");
    try {
      if (args.platform === "ios") {
        const result = await runHostCommand(
          ["xcrun", "simctl", "io", args.device_id, "screenshot", outFile],
          { signal: ctx.abortSignal, timeoutMs: 45_000 },
        );
        if (result.error) return { content: result.error, isError: true };
        if ((result.code ?? 1) !== 0) {
          return {
            content: `simctl screenshot failed: ${result.stderr || result.stdout}`,
            isError: true,
          };
        }
      } else {
        const remote = "/sdcard/envoy-harness-shot.png";
        const cap = await runHostCommand(
          ["adb", "-s", args.device_id, "shell", "screencap", "-p", remote],
          { signal: ctx.abortSignal, timeoutMs: 30_000 },
        );
        if (cap.error) return { content: cap.error, isError: true };
        if ((cap.code ?? 1) !== 0) {
          return {
            content: `adb screencap failed: ${cap.stderr || cap.stdout}`,
            isError: true,
          };
        }
        const pull = await runHostCommand(
          ["adb", "-s", args.device_id, "pull", remote, outFile],
          { signal: ctx.abortSignal, timeoutMs: 30_000 },
        );
        if (pull.error || (pull.code ?? 1) !== 0) {
          return {
            content: `adb pull failed: ${pull.error ?? pull.stderr ?? pull.stdout}`,
            isError: true,
          };
        }
        await runHostCommand(
          ["adb", "-s", args.device_id, "shell", "rm", "-f", remote],
          { signal: ctx.abortSignal, timeoutMs: 15_000 },
        );
      }

      const buf = await fs.readFile(outFile);
      const content: MultimodalToolContent = {
        text: `Screenshot from ${args.platform} device ${args.device_id} (${buf.length} bytes PNG)`,
        images: [
          {
            mimeType: "image/png",
            data: buf.toString("base64"),
          },
        ],
      };
      return { content };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};
