import { describe, expect, it } from "vitest";

import { formatGitOutput } from "../../src/protocol/git-runner.js";

describe("formatGitOutput", () => {
  it("returns (no changes) for empty stdout", () => {
    expect(formatGitOutput({ stdout: "", stderr: "", exitCode: 0 })).toBe(
      "(no changes)",
    );
  });

  it("returns stderr on hard git errors", () => {
    expect(
      formatGitOutput({
        stdout: "",
        stderr: "not a git repository",
        exitCode: 128,
      }),
    ).toBe("not a git repository");
  });
});
