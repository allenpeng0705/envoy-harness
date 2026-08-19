/**
 * envoy-harness local type system tests (Phase 1, §5 of the design).
 *
 * Verifies, for each exported schema and constant:
 * - Parse round-trip on a valid input
 * - Validation rejection on invalid input (closed enums, regex boundaries, etc.)
 * - Default values applied where applicable
 * - Cross-field validation (superRefine) on VerdictEntry
 *
 * TypeScript-only exports (interfaces, types) are exercised by the
 * compile-time check of this file: the test file imports every type
 * and uses it in at least one assertion, so a type change that breaks
 * a public export will fail to compile.
 */

import { describe, expect, it } from "vitest";

import {
  AGENTS_MD_FILENAME,
  AGENTS_OVERRIDE_FILENAME,
  AgentRuntimeSchema,
  AskForApprovalSchema,
  DEFAULT_PROJECT_DOC_MAX_BYTES,
  DEFAULT_PROJECT_ROOT_MARKERS,
  ENVOY_HARNESS_LOCAL_VERSION,
  HookEventNameSchema,
  PermissionModeSchema,
  PermissionProfileNameSchema,
  SandboxBackendSchema,
  SkillIdSchema,
  VerdictEntrySchema,
  VerdictSchema,
  VerifierSourceSchema,
  VERSION,
  type AgentRuntime,
  type AskForApproval,
  type BashValidationInput,
  type BashValidator,
  type BashVerdict,
  type DiscoveredAgentsDoc,
  type HookDecision,
  type HookEvent,
  type HookFn,
  type HookHandler,
  type LoadedAgentsMd,
  type PermissionMode,
  type PermissionProfileName,
  type ProfileRef,
  type SandboxBackend,
  type SandboxPolicy,
  type SkillId,
  type VerifierSource,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("Constants", () => {
  it("VERSION is the Phase 0 version (still 0.0.0 before the runtime lands)", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("ENVOY_HARNESS_LOCAL_VERSION is the local surface version", () => {
    expect(ENVOY_HARNESS_LOCAL_VERSION).toBe("0.1.0");
  });

  it("AGENTS_MD_FILENAME is 'AGENTS.md'", () => {
    expect(AGENTS_MD_FILENAME).toBe("AGENTS.md");
  });

  it("AGENTS_OVERRIDE_FILENAME is 'AGENTS.override.md'", () => {
    expect(AGENTS_OVERRIDE_FILENAME).toBe("AGENTS.override.md");
  });

  it("DEFAULT_PROJECT_ROOT_MARKERS is ['.git']", () => {
    expect(DEFAULT_PROJECT_ROOT_MARKERS).toEqual([".git"]);
  });

  it("DEFAULT_PROJECT_DOC_MAX_BYTES is 32 KB", () => {
    expect(DEFAULT_PROJECT_DOC_MAX_BYTES).toBe(32 * 1024);
  });
});

// ---------------------------------------------------------------------------
// §5.1 Permission and approval
// ---------------------------------------------------------------------------

describe("PermissionModeSchema", () => {
  it("accepts all 3 values", () => {
    const modes: PermissionMode[] = [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ];
    for (const mode of modes) {
      expect(PermissionModeSchema.parse(mode)).toBe(mode);
    }
  });

  it("rejects unknown values (closed enum)", () => {
    expect(() => PermissionModeSchema.parse("super-write")).toThrow();
    expect(() => PermissionModeSchema.parse("")).toThrow();
  });
});

describe("AskForApprovalSchema", () => {
  it("accepts all 4 values", () => {
    const values: AskForApproval[] = [
      "unless-trusted",
      "on-request",
      "granular",
      "never",
    ];
    for (const v of values) {
      expect(AskForApprovalSchema.parse(v)).toBe(v);
    }
  });

  it("rejects unknown values", () => {
    expect(() => AskForApprovalSchema.parse("always")).toThrow();
  });
});

describe("PermissionProfileNameSchema", () => {
  it("accepts canonical profile names", () => {
    const names: PermissionProfileName[] = [
      "read-only",
      "workspace-write",
      "danger-full-access",
      "work",
      "personal",
    ];
    for (const name of names) {
      expect(PermissionProfileNameSchema.parse(name)).toBe(name);
    }
  });

  it("rejects names with uppercase characters", () => {
    expect(() => PermissionProfileNameSchema.parse("Read-Only")).toThrow();
  });

  it("rejects names starting with a hyphen", () => {
    expect(() => PermissionProfileNameSchema.parse("-work")).toThrow();
  });

  it("rejects names > 64 chars", () => {
    const tooLong = "a" + "b".repeat(64);
    expect(() => PermissionProfileNameSchema.parse(tooLong)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// §5.2 Sandbox
// ---------------------------------------------------------------------------

describe("SandboxBackendSchema", () => {
  it("accepts all 3 backends", () => {
    const backends: SandboxBackend[] = [
      "linux-landlock",
      "process-fs-namespace",
      "none",
    ];
    for (const b of backends) {
      expect(SandboxBackendSchema.parse(b)).toBe(b);
    }
  });

  it("rejects unknown backends", () => {
    expect(() => SandboxBackendSchema.parse("macos-sandbox")).toThrow();
  });
});

describe("ProfileRef and SandboxPolicy (TypeScript-only)", () => {
  it("ProfileRef and SandboxPolicy can be constructed", () => {
    const ref: ProfileRef = { name: "work", source: "user" };
    expect(ref.name).toBe("work");
    expect(ref.source).toBe("user");

    const policy: SandboxPolicy = {
      mode: "workspace-write",
      approval: "on-request",
      backend: "linux-landlock",
      writableRoots: ["/tmp"],
      networkAccess: false,
      slashTmpWritable: true,
    };
    expect(policy.mode).toBe("workspace-write");
    expect(policy.writableRoots.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §5.3 Bash validators
// ---------------------------------------------------------------------------

describe("BashValidator (TypeScript-only)", () => {
  it("a stub validator can be constructed and run", async () => {
    const policy: SandboxPolicy = {
      mode: "read-only",
      approval: "on-request",
      backend: "linux-landlock",
      writableRoots: [],
      networkAccess: false,
      slashTmpWritable: true,
    };
    const input: BashValidationInput = {
      command: "ls -la",
      argv: ["ls", "-la"],
      env: { PATH: "/usr/bin" },
      cwd: "/tmp",
      policy,
    };
    const validator: BashValidator = {
      name: "stub-allow",
      async validate(i) {
        expect(i.command).toBe("ls -la");
        return { kind: "allow" };
      },
    };
    const verdict: BashVerdict = await validator.validate(input);
    expect(verdict.kind).toBe("allow");
  });

  it("BashVerdict discriminated union has the 3 expected kinds", () => {
    const v1: BashVerdict = { kind: "allow" };
    const v2: BashVerdict = { kind: "allow-with-warning", warning: "careful" };
    const v3: BashVerdict = { kind: "block", reason: "rm -rf /" };
    expect(v1.kind).toBe("allow");
    expect(v2.kind).toBe("allow-with-warning");
    expect(v3.kind).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// §5.4 Hook events
// ---------------------------------------------------------------------------

describe("HookEventNameSchema", () => {
  it("accepts all 12 hook events", () => {
    const events = [
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "SessionEnd",
      "Stop",
      "SubagentStop",
      "UserPromptSubmit",
      "Notification",
      "PermissionRequest",
      "Setup",
    ];
    for (const e of events) {
      expect(HookEventNameSchema.parse(e)).toBe(e);
    }
    expect(HookEventNameSchema.options.length).toBe(12);
  });

  it("rejects unknown hook event names", () => {
    expect(() => HookEventNameSchema.parse("PreToolUsed")).toThrow();
  });
});

describe("HookDecision / HookFn / HookHandler (TypeScript-only)", () => {
  it("HookDecision can be all 4 kinds", () => {
    const decisions: HookDecision[] = [
      { kind: "continue" },
      { kind: "modify", modified: { output: "new text" } },
      { kind: "block", reason: "denied" },
      { kind: "add-context", content: "extra context" },
    ];
    expect(decisions.length).toBe(4);
  });

  it("HookFn is a function type that can be assigned", async () => {
    const fn: HookFn = async (event: HookEvent) => {
      expect(event.name).toBe("SessionStart");
      return { kind: "add-context", content: "hi" };
    };
    const result = await fn({ name: "SessionStart", payload: {} });
    expect(result.kind).toBe("add-context");
  });

  it("HookHandler can declare a shell command", () => {
    const handler: HookHandler = {
      match: { tool: "bash" },
      command: "echo $TOOL_CALL >> ~/.envoymesh/audit.log",
      timeoutMs: 5000,
    };
    expect(handler.command).toContain("audit.log");
  });
});

// ---------------------------------------------------------------------------
// §5.5 AGENTS.md
// ---------------------------------------------------------------------------

describe("AGENTS.md types (TypeScript-only)", () => {
  it("DiscoveredAgentsDoc shape", () => {
    const doc: DiscoveredAgentsDoc = {
      path: "/home/user/project/AGENTS.md",
      contents: "# Project rules\nAlways run tests.",
      origin: "project",
      byteLength: 36,
    };
    expect(doc.origin).toBe("project");
    expect(doc.byteLength).toBe(36);
  });

  it("LoadedAgentsMd shape with empty entries is valid", () => {
    const loaded: LoadedAgentsMd = {
      entries: [],
      totalBytes: 0,
      assembled: "",
    };
    expect(loaded.entries.length).toBe(0);
  });

  it("LoadedAgentsMd shape with multiple entries", () => {
    const loaded: LoadedAgentsMd = {
      entries: [
        {
          path: "/home/user/.config/envoy/AGENTS.md",
          contents: "user rules",
          origin: "user",
          byteLength: 10,
        },
        {
          path: "/project/AGENTS.md",
          contents: "project rules",
          origin: "project",
          byteLength: 13,
        },
      ],
      totalBytes: 23,
      assembled: "user rules\n---\nproject rules",
    };
    expect(loaded.entries.length).toBe(2);
    expect(loaded.totalBytes).toBe(23);
  });
});

// ---------------------------------------------------------------------------
// §5.6 Verdict
// ---------------------------------------------------------------------------

describe("AgentRuntimeSchema (local)", () => {
  it("accepts envoy-harness as the first value", () => {
    expect(AgentRuntimeSchema.parse("envoy-harness")).toBe("envoy-harness");
  });

  it("accepts all 7 runtime values", () => {
    const all: AgentRuntime[] = [
      "envoy-harness",
      "openclaw",
      "pi",
      "hermes",
      "codex",
      "codex-cli",
      "openhuman",
    ];
    for (const r of all) {
      expect(AgentRuntimeSchema.parse(r)).toBe(r);
    }
    expect(AgentRuntimeSchema.options.length).toBe(7);
  });

  it("rejects unknown runtime values", () => {
    expect(() => AgentRuntimeSchema.parse("a-new-runtime")).toThrow();
  });
});

describe("SkillIdSchema (local)", () => {
  it("accepts the canonical examples", () => {
    const ids: SkillId[] = ["code-edit", "doc-search", "plan"];
    for (const id of ids) {
      expect(SkillIdSchema.parse(id)).toBe(id);
    }
  });

  it("rejects too-short and invalid characters", () => {
    expect(() => SkillIdSchema.parse("a")).toThrow();
    expect(() => SkillIdSchema.parse("with space")).toThrow();
    expect(() => SkillIdSchema.parse("UPPER")).toThrow();
  });
});

describe("VerdictSchema (local)", () => {
  it("accepts a pass verdict with default confidence='medium'", () => {
    const v = VerdictSchema.parse({ kind: "pass", score: 0.9 });
    expect(v.kind).toBe("pass");
    if (v.kind === "pass") {
      expect(v.confidence).toBe("medium");
    }
  });

  it("rejects pass score outside [0, 1]", () => {
    expect(() => VerdictSchema.parse({ kind: "pass", score: 1.5 })).toThrow();
    expect(() => VerdictSchema.parse({ kind: "pass", score: -0.1 })).toThrow();
  });

  it("accepts a fail verdict with default rollback=true", () => {
    const v = VerdictSchema.parse({ kind: "fail", reason: "bad" });
    if (v.kind === "fail") {
      expect(v.rollback).toBe(true);
    }
  });

  it("rejects disputed verdict with empty signals (min 1 required)", () => {
    expect(() =>
      VerdictSchema.parse({
        kind: "disputed",
        needsHuman: true,
        signals: [],
      }),
    ).toThrow();
  });

  it("rejects unknown verdict kinds (closed discriminator)", () => {
    expect(() => VerdictSchema.parse({ kind: "skip" })).toThrow();
  });
});

describe("VerifierSourceSchema", () => {
  it("accepts all 4 sources", () => {
    const sources: VerifierSource[] = ["rule", "llm", "human", "cross"];
    for (const s of sources) {
      expect(VerifierSourceSchema.parse(s)).toBe(s);
    }
  });
});

describe("VerdictEntrySchema (local)", () => {
  const baseEntry = {
    chainId: "chain-001",
    subtaskId: "subtask-002",
    workerPeerId: "peer-abc",
    workerRuntime: "envoy-harness" as const,
    skillId: "code-edit",
    verdict: { kind: "pass" as const, score: 0.9 },
    source: "rule" as const,
    issuedBy: "orch-peer",
    issuedAt: "2026-08-18T10:02:00.000Z",
    signature: "ed25519:rule-sig",
  };

  it("parses a valid rule-sourced entry", () => {
    const result = VerdictEntrySchema.parse(baseEntry);
    expect(result.source).toBe("rule");
  });

  it("requires verifierModel when source='llm'", () => {
    expect(() => VerdictEntrySchema.parse({ ...baseEntry, source: "llm" })).toThrow(
      /verifierModel is required/,
    );
  });

  it("accepts an llm-sourced entry with verifierModel", () => {
    const result = VerdictEntrySchema.parse({
      ...baseEntry,
      source: "llm",
      verifierModel: "claude-haiku-4-5",
    });
    expect(result.verifierModel).toBe("claude-haiku-4-5");
  });

  it("requires verifierOwnerId when source='human'", () => {
    expect(() =>
      VerdictEntrySchema.parse({ ...baseEntry, source: "human" }),
    ).toThrow(/verifierOwnerId is required/);
  });

  it("rejects empty signature", () => {
    expect(() =>
      VerdictEntrySchema.parse({ ...baseEntry, signature: "" }),
    ).toThrow();
  });
});
