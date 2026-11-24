/**
 * Family asking-control map — keep aligned with EnvoyCoder
 * `packages/agent-catalog/src/asking-control.ts`.
 */

export type FamilyAskingControl =
  | "policy"
  | "unattended-mode"
  | "launch-force"
  | "session-auto"
  | "launch-approval"
  | "none"
  | "catalog-acp"

const KNOWN: Readonly<Record<string, FamilyAskingControl>> = {
  "envoy-harness": "policy",
  "deepseek-harness": "unattended-mode",
  claudecode: "unattended-mode",
  codex: "unattended-mode",
  cursor: "launch-force",
  opencode: "session-auto",
  copilot: "none",
  pi: "none",
}

/** Settings → “ask before risky steps” wire for a featured harness id. */
export function familyAskingControl(harnessId: string): FamilyAskingControl {
  const id = harnessId.trim()
  if (!id) return "catalog-acp"
  return KNOWN[id] ?? "catalog-acp"
}

export function familyAgentCanControlAsking(harnessId: string): boolean {
  return familyAskingControl(harnessId) !== "none"
}