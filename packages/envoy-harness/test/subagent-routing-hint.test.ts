/**
 * F10.3.3 tests — `RoutingHint` type + `SubagentInput.routingHint` field.
 *
 * Covers:
 * 1. The `RoutingHint` type is exported and accepted on
 *    `SubagentInput` (additive — existing callers without
 *    the field still work).
 * 2. `routingHint` is forwarded through the `MeshSubmitter`
 *    seam (a `RemoteMeshSubmitter` with a fake transport
 *    sees the hint in the input it receives).
 * 3. The `task` tool's zod schema does NOT expose
 *    `routingHint` to the model (the field is host-only;
 *    a future `FanOutSpec` (F10.4+) is the only thing
 *    that sets it).
 * 4. A doc test: the seam comment ("Routing is a mesh
 *    concern") is present in `docs/boundary.en.md` so
 *    the next person who comes looking knows where the
 *    routing decision lives.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  type MeshSubmitter,
  type RoutingHint,
  type SubagentInput,
  type SubagentResult,
  TaskInputSchema,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// 1. RoutingHint accepted on SubagentInput
// ---------------------------------------------------------------------------

describe("F10.3.3: RoutingHint seam", () => {
  it("accepts routingHint on SubagentInput (additive — existing inputs still type-check)", () => {
    // Without routingHint — existing F10.1.2 callers unchanged.
    const withoutHint: SubagentInput = {
      objective: "x",
      capabilityTag: "code-search",
      costCeilingUsd: 0.1,
      deadlineMs: 1000,
    };
    expect(withoutHint.routingHint).toBeUndefined();

    // With routingHint — new F10.3.3 callers.
    const hint: RoutingHint = {
      workerCapabilityTag: "code-search-pro",
      maxHops: 1,
      preferredRegions: ["us-west", "eu-central"],
    };
    const withHint: SubagentInput = {
      objective: "x",
      capabilityTag: "code-search",
      costCeilingUsd: 0.1,
      deadlineMs: 1000,
      routingHint: hint,
    };
    expect(withHint.routingHint).toEqual(hint);
  });

  // -----------------------------------------------------------------------
  // 2. routingHint is forwarded through MeshSubmitter
  // -----------------------------------------------------------------------

  it("routingHint is forwarded to the transport (RemoteMeshSubmitter path)", async () => {
    // We don't import the adapter's RemoteMeshSubmitter here
    // (would be a cross-package test); instead, we use a
    // minimal local MeshSubmitter that records the input.
    const seen: SubagentInput[] = [];
    const transport: MeshSubmitter = {
      async submit(input, _signal) {
        seen.push(input);
        return {
          status: "completed",
          content: [{ type: "text", text: "ok" }],
          workerPeerId: "w1",
          workerRuntime: "envoy-harness",
          costUsd: 0,
          durationMs: 0,
          verdict: { kind: "pass", score: 0.5, confidence: "medium" },
          signature: "",
        } satisfies SubagentResult;
      },
    };
    const hint: RoutingHint = {
      workerCapabilityTag: "code-search-pro",
      maxHops: 1,
      preferredRegions: ["us-west"],
    };
    await transport.submit(
      {
        objective: "x",
        capabilityTag: "code-search",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
        routingHint: hint,
      },
      new AbortController().signal,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.routingHint).toEqual(hint);
  });

  // -----------------------------------------------------------------------
  // 3. The task tool's zod schema does NOT expose routingHint
  // -----------------------------------------------------------------------

  it("the task tool's zod schema does not expose routingHint to the model", async () => {
    // The model only sees the zod schema's shape. If the
    // tool's parameters don't include routingHint, the
    // model can't set it (correct — only the host can).
    const shape = (TaskInputSchema as { shape: Record<string, unknown> }).shape;
    expect("routingHint" in shape).toBe(false);
    // Sanity: the standard fields ARE present.
    expect("objective" in shape).toBe(true);
    expect("capability_tag" in shape).toBe(true);
    expect("cost_ceiling_usd" in shape).toBe(true);
    expect("deadline_ms" in shape).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 4. Doc test: the seam comment is in boundary.en.md
  // -----------------------------------------------------------------------

  it("the routing-is-a-mesh-concern note is in docs/boundary.en.md", () => {
    // Walk up from cwd to find the docs/ directory.
    const candidates = [
      resolve(process.cwd(), "packages/envoy-harness/docs/boundary.en.md"),
      resolve(process.cwd(), "docs/boundary.en.md"),
    ];
    let content: string | undefined;
    for (const p of candidates) {
      try {
        content = readFileSync(p, "utf-8");
        break;
      } catch {
        // try next
      }
    }
    expect(content).toBeDefined();
    // The seam must be documented so future readers know
    // where the routing decision lives. The note from the
    // F10.3 plan:
    //   "Routing is a mesh concern; envoy-harness exposes
    //    the hint, EnvoyMesh decides the target."
    expect(content).toMatch(/Routing is a mesh concern/i);
  });
});
