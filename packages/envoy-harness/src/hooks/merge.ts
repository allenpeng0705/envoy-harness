/**
 * R4.5a — merge hook decisions with dsh precedence:
 * **deny (block) > ask > allow (continue)**.
 *
 * Non-permission decisions (`add-context`, `modify`) apply only when
 * no deny/ask won the permission axis.
 */

import type { HookDecision, HookEventName } from "../types.js";

/**
 * Merge a list of per-handler decisions into one.
 *
 * Precedence:
 * 1. First `block` (deny) wins
 * 2. Else last `ask` (PreToolUse only)
 * 3. Else concatenated `add-context`
 * 4. Else last `modify` (Pre/PostToolUse)
 * 5. Else `continue` (allow)
 */
export function mergeHookDecisions(
  eventName: HookEventName,
  decisions: ReadonlyArray<HookDecision>,
): HookDecision {
  let firstBlock: Extract<HookDecision, { kind: "block" }> | undefined;
  let lastAsk: Extract<HookDecision, { kind: "ask" }> | undefined;
  let lastModify: Extract<HookDecision, { kind: "modify" }> | undefined;
  const contexts: string[] = [];

  for (const decision of decisions) {
    switch (decision.kind) {
      case "block":
        if (firstBlock === undefined) firstBlock = decision;
        break;
      case "ask":
        if (eventName === "PreToolUse") lastAsk = decision;
        break;
      case "add-context":
        contexts.push(decision.content);
        break;
      case "modify":
        if (eventName === "PostToolUse" || eventName === "PreToolUse") {
          lastModify = decision;
        }
        break;
      case "continue":
        break;
      default:
        break;
    }
  }

  if (firstBlock !== undefined) return firstBlock;
  if (lastAsk !== undefined) return lastAsk;
  if (contexts.length > 0) {
    return { kind: "add-context", content: contexts.join("\n\n") };
  }
  if (lastModify !== undefined) return lastModify;
  return { kind: "continue" };
}
