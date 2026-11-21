/**
 * Wave 1 — optional same-model Guardian reviewer.
 *
 * Asks the model for a JSON `{ decision, score?, reason? }` verdict
 * over the pending tool batch. Fail-closed on parse errors when
 * `failClosed` is true (default false → allow).
 */

import type { ModelAdapter } from "../model.js";
import type {
  GuardianReviewer,
  GuardianReviewResult,
  GuardianToolCall,
} from "./types.js";

export interface ModelGuardianOptions {
  model: ModelAdapter;
  /** When true, unparseable / empty verdicts block. Default false. */
  failClosed?: boolean;
}

export function createModelGuardian(
  options: ModelGuardianOptions,
): GuardianReviewer {
  const failClosed = options.failClosed === true;
  return {
    async reviewToolBatch(
      calls: ReadonlyArray<GuardianToolCall>,
    ): Promise<GuardianReviewResult> {
      if (calls.length === 0) {
        return { decision: "allow", score: 0 };
      }
      const listing = calls
        .map(
          (c) =>
            `- ${c.name}(${JSON.stringify(c.args).slice(0, 400)})`,
        )
        .join("\n");
      try {
        const response = await options.model.complete({
          messages: [
            {
              role: "system",
              content: [
                {
                  type: "text",
                  text:
                    "You are a security reviewer. Reply with ONLY JSON: " +
                    '{"decision":"allow"|"block","score":0-1,"reason":"..."}. ' +
                    "Block destructive, exfil, or privilege-escalation tool batches.",
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Review this tool batch:\n${listing}`,
                },
              ],
            },
          ],
          tools: [],
          temperature: 0,
        });
        const text = response.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (match === null) {
          return failClosed
            ? { decision: "block", reason: "guardian: empty model verdict" }
            : { decision: "allow", reason: "guardian: unparseable, fail-open" };
        }
        const parsed = JSON.parse(match[0]) as {
          decision?: string;
          score?: number;
          reason?: string;
        };
        const decision =
          parsed.decision === "block" ? "block" : "allow";
        return {
          decision,
          ...(typeof parsed.score === "number" ? { score: parsed.score } : {}),
          ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
        };
      } catch (err) {
        return failClosed
          ? {
              decision: "block",
              reason: `guardian model error: ${
                err instanceof Error ? err.message : String(err)
              }`,
            }
          : {
              decision: "allow",
              reason: "guardian model error, fail-open",
            };
      }
    },
  };
}
