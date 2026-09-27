/**
 * Async safe-auto consultation used by the PreToolUse ask path.
 */

import type { DecisionClient, DecisionConfig, SafeAutoRecord } from "./types.js";
import { predictWithTimeout } from "./predict.js";
import {
  SAFE_AUTO_QUESTIONS,
  applySafeAutoMode,
  buildSafeAutoState,
  makeSafeAutoRecord,
  mapSafeAutoAnswers,
  type SafeAutoStateInput,
} from "./safe-auto.js";

export interface ResolveSafeAutoAskInput {
  config: DecisionConfig;
  client: DecisionClient;
  incumbentAsk: boolean;
  tool: string;
  args?: unknown;
  stateExtras?: Omit<SafeAutoStateInput, "tool" | "args">;
  onRecord?: (record: SafeAutoRecord) => void;
}

export interface ResolveSafeAutoAskResult {
  /** Whether the harness should ask the human. */
  shouldAsk: boolean;
  /** When honorDeny + enforce + deny: block without asking. */
  deny: boolean;
  record: SafeAutoRecord;
}

/**
 * If decision mode is off, or incumbent would not ask, return incumbent.
 * Otherwise consult the client under timeout and map allow/ask/(deny→ask).
 */
export async function resolveSafeAutoAsk(
  input: ResolveSafeAutoAskInput,
): Promise<ResolveSafeAutoAskResult> {
  const { config, client, incumbentAsk, tool } = input;
  // Session autoRun "always-confirm" is a hard ask policy — safe-auto must
  // not auto-allow underneath it (even when the tool is in safeAuto.tools).
  const alwaysConfirm = input.stateExtras?.autoRun === "always-confirm";
  if (
    config.mode === "off" ||
    !config.safeAuto.enabled ||
    !incumbentAsk ||
    alwaysConfirm ||
    !config.safeAuto.tools.includes(tool)
  ) {
    const record = makeSafeAutoRecord({
      tool,
      incumbentAsk,
      decisionBackend: client.id,
      mapped: "ask",
      mode: config.mode,
      latencyMs: 0,
    });
    return { shouldAsk: incumbentAsk, deny: false, record };
  }

  const started = Date.now();
  try {
    const state = buildSafeAutoState({
      tool,
      args: input.args,
      ...(input.stateExtras ?? {}),
    });
    const response = await predictWithTimeout(
      client,
      {
        state,
        questions: { ...SAFE_AUTO_QUESTIONS },
        ...(config.model !== undefined ? { modelHint: config.model } : {}),
      },
      config.timeoutMs,
    );
    const mapped = mapSafeAutoAnswers(response, config.safeAuto);
    const applied = applySafeAutoMode(
      mapped,
      config.mode,
      config.safeAuto.honorDeny,
    );
    const record = makeSafeAutoRecord({
      tool,
      incumbentAsk,
      decisionBackend: response.backend,
      ...(response.model !== undefined ? { model: response.model } : {}),
      mapped: applied.effective,
      mode: config.mode,
      latencyMs: response.usage?.latencyMs ?? Date.now() - started,
    });
    input.onRecord?.(record);
    const deny =
      config.mode === "enforce" &&
      config.safeAuto.honorDeny &&
      applied.effective === "deny";
    return {
      // When deny is set, the permission hook must `block` (not ask).
      shouldAsk: deny ? false : applied.shouldAsk,
      deny,
      record,
    };
  } catch (err) {
    const record = makeSafeAutoRecord({
      tool,
      incumbentAsk,
      decisionBackend: client.id,
      mapped: "ask",
      mode: config.mode,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    input.onRecord?.(record);
    // Fail open to incumbent (ask).
    return { shouldAsk: true, deny: false, record };
  }
}
