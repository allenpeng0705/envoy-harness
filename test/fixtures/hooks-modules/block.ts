// Test fixture: a hook module that always blocks.
// Used by `hooks-registry.test.ts`.
import type { HookDecision, HookEvent } from "../../../src/types.js";

export default async function blockHook(
  _event: HookEvent,
): Promise<HookDecision> {
  return { kind: "block", reason: "blocked by fixture module" };
}
