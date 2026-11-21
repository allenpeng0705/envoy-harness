/**
 * `envoy-harness config dump` — print merged config without running an agent.
 */

import { loadConfigStack } from "../../config/layers.js";
import type { ConfigLayer } from "../../config/schema.js";
import type { ConfigDumpParsedArgs } from "../argv-types.js";
import type { RunOptions } from "./types.js";
import { makeEmptyRunResult } from "./helpers.js";

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|authorization)/i;

function redactLayer(layer: ConfigLayer): unknown {
  return redactValue(layer);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redactValue(v);
    }
    return out;
  }
  return value;
}

export async function runConfigDumpDispatch(
  parsed: ConfigDumpParsedArgs,
  _options: RunOptions,
  stdout: NodeJS.WritableStream,
): Promise<ReturnType<typeof makeEmptyRunResult>> {
  const stack = await loadConfigStack({
    ...(parsed.config !== undefined ? { filePath: parsed.config } : {}),
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
  });

  const payload = {
    sources: stack.sources,
    ignoredProjectKeys: stack.ignoredProjectKeys,
    layer: redactLayer(stack.layer),
    ...(parsed.effective
      ? {
          effectiveNote:
            "CLI flag winners are applied at run time; this dump is the file stack only.",
        }
      : {}),
  };

  if (parsed.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    stdout.write("envoy-harness config dump\n");
    stdout.write(`sources (${stack.sources.length}):\n`);
    for (const s of stack.sources) {
      stdout.write(`  - ${s}\n`);
    }
    if (stack.ignoredProjectKeys.length > 0) {
      stdout.write(
        `ignored project keys: ${stack.ignoredProjectKeys.join(", ")}\n`,
      );
    }
    stdout.write("merged layer (redacted):\n");
    stdout.write(`${JSON.stringify(payload.layer, null, 2)}\n`);
  }

  return makeEmptyRunResult();
}
