// Test fixture: a hook module that adds its eventName as context.
// Used by `hooks-registry.test.ts`.
import type { HookDecision, HookEvent } from "../../../src/types.js";

export default async function echoHook(
  event: HookEvent,
): Promise<HookDecision> {
  return { kind: "add-context", content: `fired:${event.name}` };
}
