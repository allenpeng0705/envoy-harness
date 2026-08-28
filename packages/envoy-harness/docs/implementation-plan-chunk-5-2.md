# Implementation plan — Phase A / Item 5 chunk 2

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (DRAFT v2, 2026-08-21)
> and [`implementation-plan.md`](./implementation-plan.md) ("Chunk 5.2 — ask_user
> tool + approval delegation").
>
> **Status:** chunk 5.1 is shipped in `8404c8f` (UserQuestionService + REPL
> provider). This doc is the executable sub-plan for **chunk 5.2**.

## Why this chunk

Chunk 5.1 defined the **service** interface (one active provider, multiplexer
semantics, `AbortSignal`-aware, optional service-level timeout) and shipped a
**REPL stdin provider** as the package-1 default. The service stands alone but
nobody calls it yet.

Chunk 5.2 wires the two callers:

1. The **model-facing `ask_user` tool** — the model can call this when it
   needs human input (e.g. "which option?", "what's the project root?").
2. The **existing `AskForApproval` flow** — when a hook returns `kind: "ask"`,
   the agent currently calls `askHandler` (which is host-injected; the v0
   default is a deny-by-default CLI shim). The shim is replaced (or wrapped)
   so it delegates to the same `UserQuestionService`.

Both callers go through the service so the human has **one** interaction
surface (chunk 5.1's principle).

## Design choices (locked at chunk start)

### 1. `ask_user` tool shape

**Schema (zod):**

```ts
{
  prompt: string,            // required, the question
  options?: string[],        // optional fixed-choice picker
  multiline?: boolean,       // optional multiline mode (paste, sentinel)
  timeoutMs?: number,        // optional; service-level timeout (chunk 5.1)
}
```

**Result mapping** (the model sees a `tool_result` with the text below):

| Service answer | `isError` | `content` (text) |
|---|---|---|
| `{ value: "yes" }` (cancelled=false) | `false` | `User answered: yes` |
| `{ value: "no", optionIndex: 1 }` | `false` | `User selected: "no" (option 2)` |
| `{ value: "long paste...", multiline=true }` | `false` | `User answered:\n<value>` |
| `{ cancelled: true, reason: "no-provider" }` | `false` | `no user channel available; please use your default answer` |
| `{ cancelled: true, reason: "aborted" \| "timeout" }` | `true` | `ask_user cancelled by user: <reason>` |

**Why `isError: false` for `no-provider`:** the tool ran successfully; there's
just no human. The model should treat this as a benign "fall through to your
default" condition, not as a tool failure. The "aborted" / "timeout" cases
*are* failures (the user actively stopped the question); `isError: true` makes
the model treat them as recovery-worthy.

**Why the tool description tells the model how to interpret the answer:**
the model needs to know which values mean "yes" vs "no" for option-picker
cases. The text is human-legible + parseable.

### 2. Auto-registration pattern (matches `meshSubmitter` + `lspManager`)

When the host provides `userQuestions` to `AgentOptions`, the constructor:

1. Registers the `ask_user` tool on the agent's `ToolRegistry` (same pattern
   as `makeTaskTool({ submitter })` and `makeLspTools(manager)`).
2. If `askHandler` is **not** set, installs an `AskForApproval` shim as the
   default `askHandler` (so the chunk-5.1 service handles approval too).

If the host provides an explicit `askHandler`, it wins (host takes precedence
over the shim). This preserves the existing v0 behavior for the CLI
(`defaultAskHandler` is still installed by the CLI runner in
`cli/run/one-shot.ts`).

**Backward compat:** when no `userQuestions` is set, the agent behaves
identically to before — no `ask_user` tool is registered, no shim is
installed. Every existing test passes unchanged.

### 3. `AskForApproval` shim — request translation

Given a `UserQuestionService`, the shim exposes an `AskHandler` that
translates between the two surfaces.

**Forward (AskRequest → UserQuestionRequest):**

- `prompt`: `"Allow {tool} to do {action}?\n\n{question}"` where
  `{action}` is a short description derived from `args` (e.g. for `bash`:
  the `command` arg; for `read_file`: the `path` arg; generic fallback:
  `JSON.stringify(args)`).
- `options`: synthesized from `AskRequest.options` as
  `["Yes", "No"]` by default. Custom `options` (via the
  shim's `options` option) are forwarded to the service
  as-is; the service is responsible for rendering the
  picker. The translation rule treats `optionIndex === 0`
  as `allow` and any other index as `deny` (most approval
  flows are 2-way; the shim is robust to N-way).
- `signal`: same as the input.

**Backward (UserQuestionAnswer → AskDecision):**

| Service answer | `AskDecision` | Reason |
|---|---|---|
| `{ optionIndex: 0, value: "Yes" }` | `{ kind: "allow" }` | first option = yes |
| `{ optionIndex: 1, value: "No" }` | `{ kind: "deny", reason: "user denied" }` | second option = no |
| `{ value: "y" \| "yes" }` (case-insensitive) | `{ kind: "allow" }` | free-form y/yes |
| `{ value: anything else }` | `{ kind: "deny", reason: "user denied" }` | free-form denial default |
| `{ cancelled: true, reason: "no-provider" }` | `{ kind: "deny", reason: "no user channel" }` | fall-through default |
| `{ cancelled: true, reason: "aborted" \| "timeout" }` | `{ kind: "deny", reason: <reason> }` | user actively stopped |

**Why deny as the default for free-form:** the deepseek convention (and our
existing v0 `defaultAskHandler` behavior) is fail-closed. A user typing
"maybe later" or "skip" is more likely "deny" than "allow" — the operator
gets to re-prompt or escalate.

**Why the "y/yes" affordance:** the REPL provider presents a numbered picker,
but the user can also type free-form. Without the affordance, the only way
to allow in the REPL is to type "1". That's friction.

### 4. The shim is a **factory**, not a singleton

`createAskForApprovalShim(service: UserQuestionService): AskHandler`. The
factory takes the service as a closure (one shim per service), so two
agents can share the same service but have independent shims (e.g. one agent
adds a "modify" option later without affecting another).

### 4a. Tracking the shim (`askHandlerIsShim`)

The agent tracks whether the current `askHandler` is the auto-installed
shim via a private `askHandlerIsShim: boolean` field. This is what lets
`setUserQuestions(s)` REPLACE the shim when the service changes
(was: a real P0 bug — the shim still closed over the old service while
the `ask_user` tool closed over the new one).

**Why a flag, not a separate field:** the tool-executor reads `askHandler`
directly via `getAskHandler`; storing them separately would require
changing the tool-executor to read both + merge. A flag keeps the
invariants local to the agent.

**Invariants maintained by the constructor + setters:**

- After construction, `askHandlerIsShim === true` iff (a) `userQuestions`
  was provided AND (b) no explicit `askHandler` was provided.
- `setAskHandler(explicit)` → `askHandlerIsShim = false` (host owns it).
- `setAskHandler(undefined)` → restores the default: shim if service set,
  else `askHandlerIsShim = false`.
- `setUserQuestions(s)` → if current is the shim OR undefined, install
  a new shim for `s`; else (explicit handler) leave it alone.

### 5. REPL integration

`runRepl` constructs a `UserQuestionService` and registers the REPL provider
before the agent is built. The provider uses the **same `process.stdin` /
`process.stdout`** as the main loop's readline; the Node `readline` package
handles concurrent interfaces correctly (the second interface pauses the
first; closing the second resumes the first).

**Caveat:** the chunk-5.2 REPL integration is a single-turn `readline` for
the ask_user call. The main loop's readline resumes when the provider's
readline closes. We don't need to do anything special — the default
`createReplStdinProvider({ input: process.stdin, output: process.stdout })`
just works.

The CLI one-shot path (`cli/run/one-shot.ts`) does NOT register a provider
by default (the chunk 5.1 design — the headless context has no human; the
existing `defaultAskHandler` is the right behavior). If a host wants
headless one-shot with a human, they inject their own provider.

## Files

### New

- `src/interaction/ask-user-tool.ts` — `makeAskUserTool(service)` factory,
  the model-facing tool (~80 LoC).
- `src/interaction/ask-for-approval-shim.ts` — `createAskForApprovalShim(service)`
  factory, the `AskHandler` shim (~70 LoC).
- `test/interaction/ask-user-tool.test.ts` — hermetic tests (~250 LoC).
- `test/interaction/ask-for-approval-shim.test.ts` — hermetic tests (~200 LoC).

### Modified

- `src/agent.ts`:
  - Add `userQuestions?: UserQuestionService` to `AgentOptions`.
  - Add `userQuestions: UserQuestionService | undefined` field on `Agent`.
  - In the constructor: if `userQuestions` is set, register the `ask_user`
    tool; if no `askHandler` is set, install the shim.
  - Add a `setUserQuestions(service | undefined)` setter for the
    `setAskHandler` symmetry (parity with the existing setters).
  - Module size: target <500 LoC, hard cap 800 LoC; `agent.ts` is already
    large (currently ~830 LoC after chunk 5.2; will need allowlist). Verify.
- `src/cli/repl/loop.ts`:
  - In `runRepl`, after the agent is built: create a `UserQuestionService`,
    register the REPL provider, set it on the agent (via the new setter).
  - On exit: dispose the provider (one-line change in the `finally`).
- `src/interaction/index.ts`:
  - Re-export `makeAskUserTool` + `createAskForApprovalShim`.
- `src/index.ts`:
  - Re-export the new factories.

### Untouched

- `src/cli/run/one-shot.ts` — preserves the existing v0 CLI behavior
  (no provider, default deny).
- `src/cli/run/helpers.ts` — `defaultAskHandler` unchanged.
- The chunk 5.1 service + REPL provider — additive only.

## Test plan (hermetic, no real stdin / LLM / network)

### `ask-user-tool.test.ts`

1. **Happy path — single-line free-form answer:**
   fake service returns `{ value: "yes", cancelled: false }` →
   tool returns `{ content: "User answered: yes" }`, no `isError`.
2. **Options-picker answer:**
   fake service returns `{ value: "no", optionIndex: 1, cancelled: false }` →
   tool returns `{ content: 'User selected: "no" (option 2)' }`.
3. **Multiline answer:**
   fake service returns `{ value: "line 1\nline 2", cancelled: false }` →
   tool returns `{ content: "User answered:\nline 1\nline 2" }`.
4. **No-provider cancellation:**
   fake service returns `{ cancelled: true, cancelledReason: "no-provider" }` →
   tool returns `{ content: "no user channel available; please use your default answer" }`,
   `isError: false`.
5. **Aborted / timeout cancellation:**
   fake service returns `{ cancelled: true, cancelledReason: "aborted" }` →
   tool returns `{ content: "ask_user cancelled by user: aborted" }`,
   `isError: true`.
6. **Service-level timeout forwarding:**
   `timeoutMs: 1000` flows through to the service (assert the fake service
   received `req.timeoutMs === 1000`).
7. **Multiline + timeout forwarding:**
   same, with `multiline: true`.
8. **Options + multiline + timeout combined:**
   one test covers the full arg shape forwarding.

### `ask-for-approval-shim.test.ts`

1. **Default options (no `AskRequest.options`):** shim sends
   `["Yes", "No"]` to the service.
2. **Custom options (first two become Yes/No):** the AskRequest's
   `[{id:"y",label:"Yes"},{id:"n",label:"No"}]` →
   shim sends `["Yes", "No"]`.
3. **Custom options with >2 entries:** drop the extras, send first two.
4. **Yes index → allow:** fake service returns `{ optionIndex: 0, value: "Yes" }` →
   shim returns `{ kind: "allow" }`.
5. **No index → deny with reason:** fake service returns `{ optionIndex: 1 }` →
   shim returns `{ kind: "deny", reason: "user denied" }`.
6. **Free-form "y" / "yes" → allow.**
7. **Free-form anything else → deny with reason.**
8. **No-provider cancellation → deny with reason "no user channel".**
9. **Aborted / timeout cancellation → deny with that reason.**
10. **Prompt rendering:** "Allow bash to run 'rm -rf /'?" includes the
    tool name + a short arg summary.
11. **Args fallback:** when `args` has no obvious "main" field
    (e.g. a custom tool), the shim falls back to `JSON.stringify(args)`.
12. **Signal passes through:** the AbortSignal is forwarded.

### Agent integration tests (in `agent.test.ts` or a new `agent-ask-user.test.ts`)

1. **Tool auto-registered when `userQuestions` is set:**
   `agent.tools.lookup("ask_user")` returns a tool; the tool's
   `execute` is the ask_user implementation.
2. **Tool NOT registered when `userQuestions` is absent:**
   `agent.tools.lookup("ask_user")` returns undefined (preserves
   existing behavior).
3. **Approval shim installed when `userQuestions` set + no `askHandler`:**
   trigger a hook returning `kind: "ask"`; the fake service receives
   the call.
4. **Existing `askHandler` wins over the shim:**
   when the host passes `askHandler` + `userQuestions`, the
   `askHandler` is called (shim is NOT installed).
5. **End-to-end tool call via scripted model:** the model emits an
   `ask_user` call; the fake service returns a canned answer; the
   tool result appears in the transcript.

### REPL integration test (in `repl-loop.test.ts` or `repl-ask-user.test.ts`)

1. **`runRepl` constructs a `UserQuestionService`** with a REPL provider.
2. **The agent is wired** with the service (ask_user tool registered).
3. **No real stdin/network/LLM** (use a fake `LineReader` that emits a
   single user message + a `ask_user` answer via a fake service).

## Module-size check

- `src/interaction/ask-user-tool.ts`: ~80 LoC.
- `src/interaction/ask-for-approval-shim.ts`: ~70 LoC.
- `src/agent.ts`: currently ~830 LoC (will need allowlist addition).
  Increment: ~30 LoC of doc + ~25 LoC of constructor code. Net ~885 LoC.

The `src/agent.ts` allowlist (from `scripts/check-module-size.mjs` /
`scripts/module-size-allowlist.json`) already exists; we add
`"src/agent.ts"` to the allowlist with a one-line note "Phase A item 5 chunk 2
+ future additive work; will split at next major refactor".

## Out of scope (later chunks)

- Tauri provider (Package 3 / adapter) — chunk 5.3 (adapter work).
- Mesh provider (Package 3) — chunk 5.3.
- `/user-questions` REPL slash command for inspecting the service status —
  chunk 5.3 (cosmetic; the service's `hasProvider()` + `providerName()`
  already expose the state).
- The service's `timeoutMs` and `multiline` UI affordances beyond what's
  already in chunk 5.1.

## Success criteria

- All 6 hermetic test files pass; existing 1048 tests still pass.
- `src/agent.ts` size stays under 800 (or is added to the allowlist with
  a documented reason).
- `pnpm test` runs in < 30s.
- The model can call `ask_user`; the result appears in the transcript.
- A hook returning `kind: "ask"` with no host `askHandler` is routed
  through the same `UserQuestionService` (one interaction surface).
- The CLI one-shot path is unchanged (existing `defaultAskHandler` still
  wins; no human channel).
- The REPL has a working `ask_user` tool backed by the REPL provider.
