/**
 * Wave 1 — `tool_search` (Codex-shaped BM25/TF-IDF over deferred tools).
 */

import { z } from "zod";

import type { Tool, ToolResult } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import {
  createDeferredGrantStore,
  getToolExposure,
  type DeferredGrantStore,
} from "./deferred.js";
import type { CodeModeGrantStore } from "./code-mode/grants.js";

export interface MakeToolSearchToolOptions {
  tools: ToolRegistry;
  grants?: DeferredGrantStore;
  /** Also mirror grants into code_mode namespaces when present. */
  codeModeGrants?: CodeModeGrantStore;
  defaultLimit?: number;
}

const Params = z.object({
  query: z.string().min(1).describe("Natural-language or keyword query."),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Max tools to grant (default 5)."),
});

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((t) => t.length > 1);
}

function scoreTool(queryTokens: string[], tool: Tool): number {
  const doc = tokenize(`${tool.name} ${tool.description}`);
  if (doc.length === 0 || queryTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  for (const q of queryTokens) {
    const f = tf.get(q) ?? 0;
    if (f === 0) continue;
    // Simple TF with name boost
    const nameBoost = tool.name.toLowerCase().includes(q) ? 3 : 1;
    score += (1 + Math.log(1 + f)) * nameBoost;
  }
  return score;
}

export function makeToolSearchTool(options: MakeToolSearchToolOptions): Tool {
  const grants = options.grants ?? createDeferredGrantStore();
  const defaultLimit = options.defaultLimit ?? 5;

  return {
    name: "tool_search",
    description:
      "Search deferred tools by keyword and grant the top matches for " +
      "this session so they appear in the catalog / code_mode namespaces.",
    parameters: Params,
    isConcurrencySafe: () => true,
    async execute(args): Promise<ToolResult> {
      const limit = args.limit ?? defaultLimit;
      const queryTokens = tokenize(args.query);
      const deferred = options.tools
        .list()
        .filter((t) => getToolExposure(t) === "deferred");
      const ranked = deferred
        .map((t) => ({ tool: t, score: scoreTool(queryTokens, t) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      const names = ranked.map((r) => r.tool.name);
      const added = grants.grant(names);
      options.codeModeGrants?.grant(names);
      return {
        content: JSON.stringify({
          ok: true,
          query: args.query,
          granted: names,
          newlyGranted: added,
          results: ranked.map((r) => ({
            name: r.tool.name,
            description: r.tool.description,
            score: Number(r.score.toFixed(3)),
          })),
        }),
      };
    },
  };
}

export { createDeferredGrantStore };
