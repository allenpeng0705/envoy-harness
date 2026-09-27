/**
 * Safe-auto gate: state builder, fixed questions, policy mapper.
 * Design §3 — v1 enforce is allow|ask only; deny is logged → ask.
 */

import type {
  DecisionAnswer,
  DecisionConfig,
  DecisionMode,
  DecisionQuestion,
  DecisionResponse,
  SafeAutoMapped,
  SafeAutoRecord,
} from "./types.js";

export const SAFE_AUTO_QUESTIONS: Readonly<
  Record<string, DecisionQuestion>
> = {
  risk: {
    type: "score",
    instructions: "How risky is allowing this tool call without a human?",
    criteria: [
      "low — read-only or trivially reversible",
      "medium — may change workspace but recoverable",
      "high — destructive, security-sensitive, or hard to undo",
    ],
  },
  destructive: {
    type: "noul",
    instructions:
      "Would this action delete data, alter secrets, exfiltrate, or escalate privileges?",
  },
  action: {
    type: "choice",
    instructions: "What should the harness do?",
    criteria: {
      allow: "Auto-allow; safe enough under current sandbox",
      ask: "Ask the human",
      deny: "Block; too dangerous even to ask casually",
    },
  },
};

export interface SafeAutoStateInput {
  tool: string;
  args?: unknown;
  objective?: string;
  permissionMode?: string;
  approval?: string;
  autoRun?: string;
  recentTools?: ReadonlyArray<string>;
}

/** Redact and truncate args / prompt text for the decision state blob. */
export function redactArgsPreview(args: unknown, maxChars = 400): string {
  if (args === undefined) return "";
  // Keep raw strings (prompts) unquoted — JSON.stringify would wrap them.
  let text: string;
  if (typeof args === "string") {
    text = args;
  } else {
    try {
      text = JSON.stringify(args);
    } catch {
      text = String(args);
    }
  }
  // Cheap secret scrub: common key patterns + bare sk-/Bearer tokens.
  text = text.replace(
    /("?(?:api[_-]?key|token|password|secret|authorization)"?\s*:\s*")([^"]*)(")/gi,
    "$1***$3",
  );
  text = text.replace(
    /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._\-]+)/gi,
    "***",
  );
  if (text.length > maxChars) return `${text.slice(0, maxChars)}…`;
  return text;
}

export function buildSafeAutoState(input: SafeAutoStateInput): string {
  const lines = [
    `objective: ${(input.objective ?? "").slice(0, 240)}`,
    `sandbox: ${input.permissionMode ?? ""} approval: ${input.approval ?? ""} autoRun: ${input.autoRun ?? ""}`,
    `tool: ${input.tool}`,
    `args: ${redactArgsPreview(input.args)}`,
    `recent: ${(input.recentTools ?? []).slice(-3).join(", ")}`,
  ];
  return lines.join("\n");
}

function asNoul(a: DecisionAnswer | undefined): number | undefined {
  return a?.type === "noul" ? a.noul : undefined;
}

function asChoice(a: DecisionAnswer | undefined): {
  choice: string;
  confidence?: number;
} | undefined {
  return a?.type === "choice"
    ? {
        choice: a.choice,
        ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
      }
    : undefined;
}

function asScore(a: DecisionAnswer | undefined): {
  score: number;
  confidence?: number;
} | undefined {
  return a?.type === "score"
    ? {
        score: a.score,
        ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
      }
    : undefined;
}

/**
 * Map model answers → allow | ask | deny intention.
 * Caller applies mode (shadow forces ask; v1 enforce coerces deny→ask).
 */
export function mapSafeAutoAnswers(
  response: DecisionResponse,
  cfg: DecisionConfig["safeAuto"],
): SafeAutoMapped {
  const destructive = asNoul(response.answers["destructive"]);
  if (
    destructive !== undefined &&
    destructive >= cfg.destructiveThreshold
  ) {
    return "ask";
  }
  const action = asChoice(response.answers["action"]);
  if (action?.choice === "deny") {
    return "deny";
  }
  const risk = asScore(response.answers["risk"]);
  // score criteria are 0=low, 1=medium, 2=high; allow only clearly low.
  const riskLow =
    risk !== undefined && risk.score <= 0.5;
  // Missing confidence is treated as "unknown → ok"; when present, both
  // action and risk must clear minConfidence (AND, not OR).
  const confidenceMeets = (c: number | undefined): boolean =>
    c === undefined || c >= cfg.minConfidence;
  const confidenceOk =
    confidenceMeets(action?.confidence) && confidenceMeets(risk?.confidence);
  if (
    action?.choice === "allow" &&
    riskLow &&
    confidenceOk &&
    (destructive === undefined || destructive < cfg.destructiveThreshold)
  ) {
    return "allow";
  }
  return "ask";
}

/**
 * Apply mode + honorDeny to a mapped intention.
 * Returns whether the harness should ASK the human (true) or auto-allow (false).
 * Deny in v1 (honorDeny false) becomes ask.
 */
export function applySafeAutoMode(
  mapped: SafeAutoMapped,
  mode: DecisionMode,
  honorDeny: boolean,
): { shouldAsk: boolean; effective: SafeAutoMapped } {
  if (mode === "off" || mode === "shadow") {
    return { shouldAsk: true, effective: mapped };
  }
  // enforce
  if (mapped === "allow") {
    return { shouldAsk: false, effective: "allow" };
  }
  if (mapped === "deny" && honorDeny) {
    // Caller returns PreToolUse `block` when `deny` is set on the resolve result.
    return { shouldAsk: false, effective: "deny" };
  }
  return { shouldAsk: true, effective: mapped === "deny" ? "deny" : "ask" };
}

export function makeSafeAutoRecord(partial: {
  tool: string;
  incumbentAsk: boolean;
  decisionBackend: string;
  model?: string;
  mapped: SafeAutoMapped;
  mode: DecisionMode;
  latencyMs: number;
  error?: string;
}): SafeAutoRecord {
  return {
    ts: new Date().toISOString(),
    tool: partial.tool,
    incumbentAsk: partial.incumbentAsk,
    decisionBackend: partial.decisionBackend,
    ...(partial.model !== undefined ? { model: partial.model } : {}),
    mapped: partial.mapped,
    mode: partial.mode,
    latencyMs: partial.latencyMs,
    ...(partial.error !== undefined ? { error: partial.error } : {}),
  };
}
