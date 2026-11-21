/**
 * CLI mesh submitter forwards live permission/sandbox getters.
 */

import { describe, expect, it } from "vitest";

import { buildCliLocalMeshSubmitter } from "../../src/cli/run/build-local-mesh-submitter.js";
import type { ModelAdapter, ModelResponse } from "../../src/index.js";
import { policyFromMode } from "../../src/permissions/policy.js";

function scriptedModel(
  responses: ReadonlyArray<ModelResponse["content"]>,
): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const content = responses[i++] ?? [{ type: "text", text: "done" }];
      return { content, stopReason: "end_turn" as const };
    },
  };
}

describe("buildCliLocalMeshSubmitter", () => {
  it("invokes live permission/sandbox getters at each child spawn", async () => {
    let permCalls = 0;
    let sandboxCalls = 0;
    let liveMode: "read-only" | "workspace-write" = "workspace-write";
    const submitter = buildCliLocalMeshSubmitter({
      model: scriptedModel([
        [{ type: "text", text: "ok-a" }],
        [{ type: "text", text: "ok-b" }],
      ]),
      cwd: "/tmp",
      permissionMode: "read-only",
      getPermissionMode: () => {
        permCalls += 1;
        return liveMode;
      },
      getSandboxPolicy: () => {
        sandboxCalls += 1;
        return policyFromMode(liveMode, "/tmp");
      },
      parentSessionId: "parent-1",
    });

    const r1 = await submitter.submit(
      {
        objective: "a",
        capabilityTag: "research",
        costCeilingUsd: 0.1,
        deadlineMs: 5_000,
      },
      new AbortController().signal,
    );
    expect(r1.status).toBe("completed");
    expect(permCalls).toBeGreaterThanOrEqual(1);
    expect(sandboxCalls).toBeGreaterThanOrEqual(1);

    const afterFirst = permCalls;
    liveMode = "read-only";
    const r2 = await submitter.submit(
      {
        objective: "b",
        capabilityTag: "research",
        costCeilingUsd: 0.1,
        deadlineMs: 5_000,
      },
      new AbortController().signal,
    );
    expect(r2.status).toBe("completed");
    expect(permCalls).toBeGreaterThan(afterFirst);
    expect(submitter.listSubagents()).toHaveLength(2);
  });

  it("forwards getSandboxPolicy alone while permission stays on the snapshot", async () => {
    let sandboxCalls = 0;
    const submitter = buildCliLocalMeshSubmitter({
      model: scriptedModel([[{ type: "text", text: "ok" }]]),
      cwd: "/tmp",
      permissionMode: "read-only",
      getSandboxPolicy: () => {
        sandboxCalls += 1;
        return policyFromMode("workspace-write", "/tmp");
      },
    });
    const result = await submitter.submit(
      {
        objective: "sandbox-only",
        capabilityTag: "research",
        costCeilingUsd: 0.1,
        deadlineMs: 5_000,
      },
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(sandboxCalls).toBeGreaterThanOrEqual(1);
  });
});
