/**
 * spawnCapture live stdout callback (tool_progress / Phase B).
 */

import { describe, expect, it } from "vitest";

import { spawnCapture } from "../../src/sandbox/backends/spawn-capture.js";

describe("spawnCapture onStdout", () => {
  it("emits stdout chunks while the child runs", async () => {
    const chunks: string[] = [];
    const result = await spawnCapture({
      file: "sh",
      args: ["-c", "printf 'a\\nb'"],
      cwd: process.cwd(),
      signal: undefined,
      onStdout: (c) => chunks.push(c),
    });
    expect(result.isError).toBe(false);
    expect(chunks.join("")).toContain("a");
    expect(result.stdout).toContain("a");
  });
});
