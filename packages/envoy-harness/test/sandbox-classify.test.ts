/**
 * Sandbox failure classification.
 *
 * The load-bearing property is the **false-positive guard**: an ordinary
 * shell failure must never be labelled a sandbox denial, because the
 * model's response to a denial is "stop and change approach", which is
 * the wrong move for a typo.
 */

import { describe, expect, it } from "vitest";

import {
  OUTPUT_SNIPPET_MAX_CHARS,
  SANDBOX_LAUNCHER_FAILURE_EXIT,
  classifySandboxFailure,
  describeSandboxDenial,
  describeSandboxInfrastructureFailure,
  extractDeniedPath,
  formatSandboxFailure,
  isSandboxDenial,
  policyToViolationBackend,
  type SandboxFailure,
} from "../src/sandbox/classify.js";

function classify(
  overrides: Partial<Parameters<typeof classifySandboxFailure>[0]> = {},
): SandboxFailure | undefined {
  return classifySandboxFailure({
    backend: "landlock",
    exitCode: 1,
    stderr: "",
    stdout: "",
    ...overrides,
  });
}

describe("quick-reject exit codes", () => {
  it("never classifies 2, 126 or 127 as a denial, even with denial text", () => {
    // This is the whole point: `sh: 1: frobnicate: not found` is exit 127
    // and says "not found" — a typo, not a policy decision.
    for (const exitCode of [2, 126, 127]) {
      const failure = classify({
        exitCode,
        stderr: "permission denied: /etc/passwd",
      });
      expect(failure).toBeUndefined();
    }
  });

  it("does not let a quick-reject code mask a launcher failure on another run", () => {
    expect(
      classify({ exitCode: SANDBOX_LAUNCHER_FAILURE_EXIT })?.kind,
    ).toBe("infrastructure");
  });
});

describe("normal exits", () => {
  it("returns undefined for exit 0", () => {
    expect(classify({ exitCode: 0 })).toBeUndefined();
  });

  it("returns undefined for an ordinary non-zero exit with no denial text", () => {
    expect(
      classify({ exitCode: 1, stderr: "AssertionError: expected 1 to be 2" }),
    ).toBeUndefined();
  });

  it("returns undefined for a null exit code with no denial text", () => {
    expect(classify({ exitCode: null })).toBeUndefined();
  });
});

describe("backend gating", () => {
  it("never reports a denial when no backend enforces policy", () => {
    // `bash` noop / danger-full-access: the text may *say* denied, but
    // nothing in this process enforced it, so it must be a program error.
    expect(
      classify({
        backend: "none",
        exitCode: 1,
        stderr: "touch: cannot touch '/etc/x': Permission denied",
      }),
    ).toBeUndefined();
  });

  it("treats the fs-namespace backend as enforcing", () => {
    const failure = classify({
      backend: "fs-namespace",
      exitCode: 1,
      stderr: "bash: /root/out: Read-only file system",
    });
    expect(failure?.kind).toBe("denied");
  });
});

describe("reason keywords", () => {
  it("maps each known keyword to its reason", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["touch: /w/x: Read-only file system", "read_only_file_system"],
      ["mv: /w/x: Operation not permitted", "operation_not_permitted"],
      ["cat: /etc/shadow: Permission denied", "permission_denied"],
      ["failed to write file /w/x", "failed_to_write_file"],
      ["sandbox_denied: write /etc", "policy_denied"],
      ["landlock: ruleset rejected", "policy_denied"],
    ];
    for (const [stderr, reason] of cases) {
      const failure = classify({ exitCode: 1, stderr });
      expect(failure?.kind, stderr).toBe("denied");
      if (failure?.kind === "denied") expect(failure.reason, stderr).toBe(reason);
    }
  });

  it("prefers read-only over permission-denied when both appear", () => {
    const failure = classify({
      exitCode: 1,
      stderr: "Read-only file system (permission denied in some other message)",
    });
    expect(failure?.kind === "denied" && failure.reason).toBe(
      "read_only_file_system",
    );
  });

  it("detects denial text on stdout as well as stderr", () => {
    const failure = classify({
      exitCode: 1,
      stdout: "python: Permission denied: '/etc/passwd'",
    });
    expect(failure?.kind).toBe("denied");
  });
});

describe("SIGSYS", () => {
  it("is a denial by definition (seccomp killed the syscall)", () => {
    const failure = classify({ exitCode: null, signal: "SIGSYS" });
    expect(failure?.kind === "denied" && failure.reason).toBe("signal_syscall");
  });

  it("wins over a quick-reject exit code", () => {
    // A signal death has no exit code, but if a backend reports both we
    // must not silently drop the denial.
    const failure = classify({ exitCode: 127, signal: "SIGSYS" });
    expect(failure?.kind).toBe("denied");
  });

  it("does not treat SIGKILL as a denial", () => {
    expect(classify({ exitCode: null, signal: "SIGKILL" })).toBeUndefined();
  });
});

describe("launcher failure", () => {
  it("reports exit 125 as infrastructure, not denial", () => {
    const failure = classify({
      exitCode: SANDBOX_LAUNCHER_FAILURE_EXIT,
      stderr: "landlock unavailable",
    });
    expect(failure?.kind).toBe("infrastructure");
    if (failure?.kind === "infrastructure") {
      expect(failure.detail).toBe("landlock unavailable");
      expect(failure.backend).toBe("landlock");
    }
  });

  it("still reports infrastructure with no output at all", () => {
    const failure = classify({ exitCode: SANDBOX_LAUNCHER_FAILURE_EXIT });
    expect(failure?.kind).toBe("infrastructure");
    if (failure?.kind === "infrastructure") {
      expect(failure.detail).toBe("sandbox launcher failed");
    }
  });
});

describe("output snippet", () => {
  it("caps the excerpt", () => {
    const failure = classify({
      exitCode: 1,
      stderr: `Permission denied ${"x".repeat(4000)}`,
    });
    expect(failure?.outputSnippet.length).toBeLessThanOrEqual(
      OUTPUT_SNIPPET_MAX_CHARS,
    );
    expect(failure?.outputSnippet.endsWith("…")).toBe(true);
  });

  it("keeps short output verbatim and trimmed", () => {
    const failure = classify({ exitCode: 1, stderr: "  Permission denied  \n" });
    expect(failure?.outputSnippet).toBe("Permission denied");
  });
});

describe("extractDeniedPath", () => {
  it("finds the path named before a known errno", () => {
    expect(
      extractDeniedPath("touch: cannot touch '/etc/hosts': Permission denied"),
    ).toBe("/etc/hosts");
    expect(extractDeniedPath("/var/lib/db: Read-only file system")).toBe(
      "/var/lib/db",
    );
  });

  it("finds the path in a 'cannot open' phrasing", () => {
    expect(extractDeniedPath("cannot open /tmp/x for writing")).toBe("/tmp/x");
  });

  it("refuses to guess at a bare program name", () => {
    // `sh: Permission denied` has no path; inventing one would send the
    // model to widen the wrong root.
    expect(extractDeniedPath("sh: Permission denied")).toBeUndefined();
  });

  it("ignores a relative path with no explicit ./ prefix", () => {
    expect(extractDeniedPath("write failed for notes.txt: Permission denied")).toBe(
      undefined,
    );
  });
});

describe("policyToViolationBackend", () => {
  it("maps every configured backend onto an enforcing name", () => {
    expect(policyToViolationBackend("linux-landlock")).toBe("landlock");
    expect(policyToViolationBackend("darwin-sandbox")).toBe("seatbelt");
    expect(policyToViolationBackend("windows-sandbox")).toBe("windows-job");
    expect(policyToViolationBackend("process-fs-namespace")).toBe("fs-namespace");
    expect(policyToViolationBackend("none")).toBe("none");
  });
});

describe("isSandboxDenial", () => {
  it("is false for undefined and for infrastructure failures", () => {
    expect(isSandboxDenial(undefined)).toBe(false);
    expect(
      isSandboxDenial(classify({ exitCode: SANDBOX_LAUNCHER_FAILURE_EXIT })),
    ).toBe(false);
  });

  it("is true for a denial", () => {
    expect(isSandboxDenial(classify({ exitCode: 1, stderr: "Permission denied: /x" }))).toBe(
      true,
    );
  });
});

describe("model-facing text", () => {
  it("names the path and the backend and says retrying is pointless", () => {
    const failure = classify({
      exitCode: 1,
      stderr: "touch: cannot touch '/etc/hosts': Permission denied",
    });
    if (failure?.kind !== "denied") throw new Error("expected a denial");
    const text = describeSandboxDenial(failure);
    expect(text).toContain("landlock");
    expect(text).toContain("/etc/hosts");
    expect(text).toContain("permission denied");
    expect(text).toContain("re-running the same command will fail identically");
  });

  it("says the opposite for infrastructure: the command never ran", () => {
    const failure = classify({ exitCode: SANDBOX_LAUNCHER_FAILURE_EXIT });
    if (failure?.kind !== "infrastructure") throw new Error("expected infra");
    const text = describeSandboxInfrastructureFailure(failure);
    expect(text).toContain("never");
    expect(text).toContain("retrying the identical command will not");
  });

  it("prefixes the annotation and returns undefined when there is none", () => {
    expect(
      formatSandboxFailure(classify({ exitCode: 1, stderr: "Operation not permitted: /x" })),
    ).toMatch(/^\[sandbox\] /);
    expect(formatSandboxFailure(undefined)).toBeUndefined();
    expect(formatSandboxFailure(classify({ exitCode: 1, stderr: "boom" }))).toBeUndefined();
  });
});
