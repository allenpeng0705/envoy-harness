# Envoy Harness TUI UX Design

Status: Proposed

## Goal

Provide a fast, keyboard-first coding-agent console with clear execution state,
safe approvals, structured tool activity, reliable scrollback, and full
Unicode/terminal compatibility.

## Layout

```text
envoy-harness · project · branch · model · executor · state · elapsed
Chat  Plan  Memory  Diff(3)  Jobs(1)  Mesh
---------------------------------------------------------------------
transcript or active detail view

blocking approval/question or contextual hint
> multiline composer
```

The top line collapses fields from right to left on narrow terminals. Tabs with
new information show counts; inactive, unchanged tabs remain visually quiet.

## Interaction states

| State | Status | Composer behavior |
|---|---|---|
| Ready | `ready` | Enter sends |
| Thinking | current activity + elapsed | Enter queues |
| Tool running | tool + progress + elapsed | Enter queues |
| Approval | `waiting for approval` | focus approval actions |
| Question | `waiting for answer` | focus choices/input |
| Reconnecting | last activity + retry count | drafts remain editable |
| Completed | files/tests summary | Enter continues |

## Transcript rules

- Assistant prose is primary.
- Consecutive tool events collapse into one activity group.
- Tool details expand in place without destroying scroll position.
- Streaming modifies one existing row.
- Errors and cancellation remain visible.
- Completion ends with verification and changed-file summary.
- Search results jump to stable timeline IDs.

## Keymap

| Key | Action |
|---|---|
| Enter | Send or activate selected action |
| Shift/Alt+Enter | Insert newline |
| Esc | Dismiss palette/view; second Esc requests cancel |
| Ctrl+C | Cancel active turn; when idle clear input |
| Ctrl+P | Command palette |
| Ctrl+R | Search transcript/history |
| Ctrl+O | Expand/collapse selected activity |
| Ctrl+G | Changed files/diff |
| Ctrl+T | Active/background jobs |
| Page Up/Down | Scroll transcript/details |
| Tab/Shift+Tab | Move focus |
| Ctrl+D | Exit only with empty input and no blocking request |

Mouse wheel scrolling is supported when the terminal reports mouse events, but
every operation remains keyboard-accessible.

## Approval design

```text
┌ Run command? ───────────────────────────────────────────────┐
│ npm install                                                 │
│ Workspace: EnvoyMesh · Network: yes · Executor: local      │
│ May change package-lock.json and node_modules               │
│                                                            │
│ [D] Deny       [O] Allow once       [T] Allow this turn     │
└────────────────────────────────────────────────────────────┘
```

The selected action has a visible focus marker. Dangerous persistent policy
changes are not offered in this card.

## Tool and diff presentation

Compact:

```text
✓ Read 4 files
⚙ npm test · 18s · 23/31 passed
✓ Edited 3 files · +18 −4
```

Expanded tool details preserve ANSI-stripped output, exit code, duration, and
executor attribution. Diff view supports unified hunks, next/previous file,
copy path, and open-in-editor escape hooks.

## Terminal correctness

- Measure display columns, not JavaScript string length.
- Ignore ANSI sequences during measurement.
- Preserve grapheme clusters and wide glyphs.
- Relayout on resize without losing selection or scroll position.
- Never split an ANSI escape or leave styling active after truncation.
- Support widths down to 40 columns and heights down to 10 rows.
- Fall back to plain mode for pipes and unsupported terminals.

## Component changes

```text
TuiSession
  -> TimelineReducer
  -> ViewState (focus, scroll, expansion, selection)
  -> LayoutEngine
  -> ScreenRenderer
```

Split the current large session module into:

- `timeline-reducer.ts`
- `interaction-controller.ts`
- `approval-controller.ts`
- `history-controller.ts`
- `view-state.ts`
- `layout/columns.ts`
- `layout/viewport.ts`

ACP handling belongs in an adapter and must not directly format transcript
strings.

## Delivery plan

### T1 — State and timeline foundation

- Consume shared timeline/state contracts.
- Add stable-ID reducer and replay/deduplication tests.
- Preserve the current transcript behind an adapter.

### T2 — View state and navigation

- Add focus, scrollback, selection, and expansion state.
- Implement Page Up/Down, Tab navigation, search, and command palette.
- Add resize and narrow-terminal tests.

### T3 — Blocking interactions

- Structured approval and question panels.
- Keyboard shortcuts and delivery acknowledgement.
- Reconnection restoration for pending requests.

### T4 — Tool timeline and review

- Collapsible activities and live progress.
- Changed-file completion card and diff navigation.
- Job view and executor attribution.

### T5 — accessibility and performance

- No-color/high-contrast modes.
- CJK, emoji, combining-mark, and RTL fixture coverage.
- Render batching and large-history performance tests.

## Acceptance scenarios

1. Resize during streaming without cursor drift or lost text.
2. Approve a command using keyboard only.
3. Disconnect during approval and restore the same request.
4. Search a 1,000-item transcript and return to the previous scroll position.
5. Expand a running tool without creating duplicate output rows.
6. Review three changed files and return to chat without losing the draft.
7. Use CJK and emoji in prompts at 40-, 80-, and 160-column widths.

