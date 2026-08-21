/**
 * F17.5 — Tier 2 batch 1 commands (real features).
 *
 * Three commands that go beyond print/info:
 * - `/new` — start a fresh session (clear transcript + new id)
 * - `/compact` — context window compaction (basic: drop oldest
 *   messages, keep recent N)
 * - `/init` — generate AGENTS.md via an LLM call + write to cwd
 *
 * **Why a separate file:** these commands need new Agent
 * capabilities (`newSession`, `compact`, `generateAgentsMd`).
 * The Tier 1 commands (F17.2.5) were pure data display.
 *
 * **v0 limitations:**
 * - `/compact` is the simple "drop oldest" version. A future
 *   chunk can add LLM-based summarization (F17.5+ candidate).
 * - `/init` uses a one-shot model call. The result is written
 *   to `<cwd>/AGENTS.md` (overwrites existing). The model call
 *   is NOT added to the main session transcript (it's a side
 *   effect, like `git init`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ContentBlock, Message } from "../../index.js";
import type { ReplCommand } from "./types.js";

/**
 * Default number of recent messages to keep when compacting.
 * Codex / Claude Code / pi use 20-30; we default to 20 to
 * match the lower end. F17.5 doesn't expose this as a flag;
 * it's a future chunk.
 */
const DEFAULT_COMPACT_KEEP = 20;

// ---------------------------------------------------------------------------
// 1. /new — start a fresh session
// ---------------------------------------------------------------------------

const newCommand: ReplCommand = {
  name: "/new",
  description: "start a fresh session (new id, empty transcript)",
  handler(_args, ctx) {
    ctx.agent.newSession();
    ctx.stdout.write(`new session: ${ctx.agent.getSessionId()}\n`);
  },
};

// ---------------------------------------------------------------------------
// 2. /compact — context window compaction (basic: drop oldest N)
// ---------------------------------------------------------------------------

const compactCommand: ReplCommand = {
  name: "/compact",
  description: "compact the session (drop oldest, keep recent N; --summarize to LLM-summarize the dropped part)",
  async handler(args, ctx) {
    // Phase 8 / v2.1 — `/compact --summarize [keep]`: summarize
    // the dropped messages with a one-shot model call (Codex
    // compaction parity) instead of dropping them silently.
    let summarize = false;
    if (args[0] === "--summarize") {
      summarize = true;
      args = args.slice(1);
    }
    // Parse optional `<keep>` arg (default 20).
    let keep = DEFAULT_COMPACT_KEEP;
    if (args.length > 0) {
      const first = args[0];
      if (first === undefined) {
        // No-op.
      } else {
        const n = Number(first);
        if (!Number.isFinite(n) || n <= 0) {
          ctx.stderr.write(
            `error: invalid keep count: ${first} (expected a positive number)\n`,
          );
          return;
        }
        keep = n;
      }
    }

    const before = ctx.agent.getMessageCount();
    if (summarize) {
      try {
        await ctx.agent.compactWithSummary(keep, async (dropped) => {
          const text = dropped
            .map((m) => `${m.role}: ${JSON.stringify(m.content)}`)
            .join("\n");
          const result = await ctx.agent.getModel().complete({
            messages: [
              {
                role: "system",
                content: [
                  {
                    type: "text",
                    text:
                      "You are a session summarizer. Summarize the dropped " +
                      "conversation below into 2-4 sentences, preserving " +
                      "decisions, file paths, and unresolved questions. " +
                      "Output ONLY the summary.",
                  },
                ],
              },
              { role: "user", content: [{ type: "text", text }] },
            ],
            tools: [],
          });
          return result.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
        });
      } catch (err) {
        ctx.stderr.write(
          `error: summarization failed (${(err as Error).message}); falling back to drop-oldest\n`,
        );
        ctx.agent.compact(keep);
      }
    } else {
      ctx.agent.compact(keep);
    }
    const after = ctx.agent.getMessageCount();
    ctx.stdout.write(
      `compacted: ${before} → ${after} messages (kept last ${keep}${summarize ? ", with summary" : ""})\n`,
    );
  },
};

// ---------------------------------------------------------------------------
// 3. /init — generate AGENTS.md via the LLM
// ---------------------------------------------------------------------------

/**
 * System prompt for the AGENTS.md generator. The LLM is told
 * to examine the cwd and write a project-specific AGENTS.md
 * (similar to `claude /init` + `codex --init`).
 */
const INIT_SYSTEM_PROMPT = `You are an AGENTS.md generator.
Examine the current working directory using the read_file and
list_dir tools. Write a concise AGENTS.md (max 200 lines) that
captures:
- The project's purpose (what it does, in 1-2 sentences)
- The tech stack (language, framework, key dependencies)
- The build / test / lint commands
- Code style conventions (if you can infer them)
- Anything unusual about the project that an AI agent would
  need to know to be productive.

Output ONLY the AGENTS.md content (no commentary, no fences).
Do not include any other text.`;

/**
 * The single message we send to the model. The model uses
 * tools to inspect the cwd, then returns the AGENTS.md
 * content as the response text.
 */
const INIT_USER_PROMPT = "Examine the current working directory and write an AGENTS.md.";

/**
 * Parse a model response and return the text content.
 * v0: the model returns a flat text block (no tool calls
 * needed — the prompt is short and the model has direct
 * knowledge of the cwd via tools, but for v0 we keep it
 * simple: a single text response).
 *
 * **Why no tool loop:** the v0 implementation just sends a
 * single user message; the LLM responds with text. A future
 * chunk can add a proper tool loop (read_file + list_dir)
 * if the LLM needs to inspect the cwd.
 */
function extractText(content: ReadonlyArray<ContentBlock>): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

const initCommand: ReplCommand = {
  name: "/init",
  description: "generate AGENTS.md for the current cwd",
  async handler(_args, ctx) {
    const cwd = ctx.args.cwd ?? process.cwd();
    const target = path.join(cwd, "AGENTS.md");

    // F-fix: `/init` writes a file. In a read-only session
    // (default, or after `/sandbox read-only`) that must be
    // refused — the sandbox policy applies to the REPL's own
    // commands too.
    if (ctx.agent.getPermissionMode() === "read-only") {
      ctx.stderr.write(
        "error: /init writes AGENTS.md, but the session is read-only " +
          "(use /sandbox workspace-write first)\n",
      );
      return;
    }

    // 1. Fire the model directly (NOT through `agent.run`).
    //
    //    **Why bypass agent.run:** `/init` is a one-shot
    //    side effect, not a real conversation turn. Adding
    //    the AGENTS.md generator prompt + response to the
    //    main transcript would confuse the next turn
    //    ("why is there an AGENTS.md generator prompt in
    //    my context?"). So we just call the model adapter
    //    with a fresh message array and capture the text.
    //
    //    **v0 simplification:** no tool loop, no session.
    //    Just the system prompt + user prompt and a text
    //    response. A future chunk can add a proper tool
    //    loop (read_file + list_dir) if the LLM needs to
    //    inspect the cwd.
    let result: { content: ReadonlyArray<ContentBlock>; stopReason?: string };
    try {
      const messages: ReadonlyArray<Message> = [
        { role: "system", content: [{ type: "text", text: INIT_SYSTEM_PROMPT }] },
        { role: "user", content: [{ type: "text", text: INIT_USER_PROMPT }] },
      ];
      result = await ctx.agent.getModel().complete({
        messages,
        tools: [],
      });
    } catch (err) {
      ctx.stderr.write(`error: model call failed: ${(err as Error).message}\n`);
      return;
    }

    const text = extractText(result.content);
    if (text.length === 0) {
      ctx.stderr.write("error: model returned no text\n");
      return;
    }

    // 2. Write the AGENTS.md. We DON'T create the parent
    //    dir (the cwd is presumed to exist; if it doesn't,
    //    the write fails with a clear error).
    try {
      await fs.writeFile(target, text + "\n", "utf-8");
    } catch (err) {
      ctx.stderr.write(`error: failed to write ${target}: ${(err as Error).message}\n`);
      return;
    }

    ctx.stdout.write(`wrote AGENTS.md: ${target} (${text.split("\n").length} lines)\n`);
  },
};

/**
 * F17.5: list of the 3 Tier 2 batch 1 commands. The runner
 * includes this in the default registry after
 * `BUILTIN_COMMANDS` and `BUILTIN_INFO_COMMANDS` (built-ins
 * always win on name collision).
 *
 * **Defined last** because each entry is a `const` declared
 * above. Forward references in `const` arrays would force
 * us to either inline the literals (less readable) or
 * convert each command to a function declaration (less
 * idiomatic for a data literal). The bottom-of-file
 * position is the cleanest fix (same pattern as
 * `BUILTIN_COMMANDS` in `commands.ts` and
 * `BUILTIN_INFO_COMMANDS` in `commands-info.ts`).
 */
export const BUILTIN_TIER2_COMMANDS: ReadonlyArray<ReplCommand> = [
  newCommand,
  compactCommand,
  initCommand,
];
