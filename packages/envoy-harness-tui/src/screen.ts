/**
 * U2 — ANSI screen module for the dedicated envoy-harness TUI.
 *
 * A small dependency-free screen: fixed regions (status bar, optional
 * cluster rail, transcript window, input line), diff-based rendering
 * (only changed rows are rewritten), and pure layout helpers that are
 * hermetic-tested without a TTY.
 */

export interface ScreenLayoutModel {
  statusLine: string;
  /** Optional one-line cluster rail (peers + health). */
  railLine?: string;
  /** U6 — view tab strip (Chat · Plan · Memory · Diff · Mesh). */
  tabLine?: string;
  /** Full transcript; the renderer keeps the bottom window. */
  transcript: readonly string[];
  /** The composer buffer split into lines (last line is the bottom row). */
  inputLines: readonly string[];
  /** 0-based line within `inputLines` the cursor is on. Default: last. */
  inputCursorLine?: number;
  /** 0-based cursor column within that line. Default: end of the line. */
  inputCursor?: number;
  /** Optional slash-command palette rows (drawn above the composer). */
  palette?: readonly string[];
  /** Index of the highlighted palette row. */
  paletteSelected?: number;
  /** U6a.5 — dim hint above composer (e.g. image paste). */
  composerHint?: string;
}

export interface ScreenOptions {
  /** Terminal width (default 80). */
  width?: number;
  /** Terminal height (default 24). */
  height?: number;
  /**
   * U5 — ANSI SGR prefix for the status bar (e.g. `"\x1b[36m"` cyan).
   * The row is wrapped with `accent` … `\x1b[0m` at render time.
   */
  accent?: string;
}

/** Truncate a line to `width` columns (fits ≥ 1). */
export function fitLine(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

/**
 * Compute the fixed-height row layout for a model. Pure — testable
 * without a TTY.
 */
export function layoutRows(
  model: ScreenLayoutModel,
  width: number,
  height: number,
): string[] {
  const rows: string[] = [];
  rows.push(fitLine(model.statusLine, width));
  if (model.railLine !== undefined) {
    rows.push(fitLine(model.railLine, width));
  }
  if (model.tabLine !== undefined) {
    rows.push(fitLine(model.tabLine, width));
  }
  const inputLines = model.inputLines.length > 0 ? model.inputLines : [""];
  const palette = model.palette ?? [];
  const hintRows = model.composerHint !== undefined ? 1 : 0;
  const bottom = palette.length + inputLines.length + hintRows;
  const usedTop = rows.length; // status + optional rail + optional tabs
  const transcriptHeight = Math.max(0, height - usedTop - bottom);
  const tail = model.transcript.slice(-transcriptHeight);
  for (const line of tail) {
    rows.push(fitLine(line, width));
  }
  while (rows.length < height - bottom) {
    rows.push("");
  }
  palette.forEach((item, i) => {
    rows.push(
      fitLine(`${i === model.paletteSelected ? ">" : " "} ${item}`, width),
    );
  });
  if (model.composerHint !== undefined) {
    rows.push(fitLine(model.composerHint, width));
  }
  for (const line of inputLines) {
    rows.push(fitLine(line, width));
  }
  return rows;
}

export interface StatusBarInfo {
  sessionId?: string;
  model?: string;
  clusterConnected?: number;
  clusterTotal?: number;
  /** When true, show `mesh · /mesh` instead of cluster counts (no peers yet). */
  meshHint?: boolean;
  busy?: boolean;
  /** U6 — active detail view (shown when not chat). */
  view?: string;
}

/** Tab ids rendered in the main strip (coding-agent panels). */
export const VIEW_TAB_IDS = [
  "chat",
  "plan",
  "memory",
  "git-diff",
  "mesh",
] as const;

export type ViewTabId = (typeof VIEW_TAB_IDS)[number];

const VIEW_TAB_LABELS: Record<ViewTabId, string> = {
  chat: "Chat",
  plan: "Plan",
  memory: "Memory",
  "git-diff": "Diff",
  mesh: "Mesh",
};

/**
 * U6 — one-line tab strip. Active tab is bold; optional accent on active.
 * Maps cluster/team/scoreboard views to Mesh tab highlight.
 */
export function buildViewTabLine(
  activeView: string,
  options?: { accent?: string },
): string {
  const meshViews = new Set([
    "mesh",
    "cluster",
    "peers",
    "team",
    "scoreboard",
    "route",
    "trace",
  ]);
  const highlighted: ViewTabId = meshViews.has(activeView)
    ? "mesh"
    : VIEW_TAB_IDS.includes(activeView as ViewTabId)
      ? (activeView as ViewTabId)
      : "chat";
  const parts = VIEW_TAB_IDS.map((id) => {
    const label = VIEW_TAB_LABELS[id];
    if (id !== highlighted) return label;
    const text = `[${label}]`;
    if (options?.accent !== undefined) {
      return `${options.accent}${text}\x1b[0m`;
    }
    return text;
  });
  return parts.join("  ");
}

/** Build the one-line status bar (pure). */
export function buildStatusLine(info: StatusBarInfo): string {
  const parts = ["envoy-harness"];
  if (info.sessionId !== undefined) parts.push(`session ${info.sessionId}`);
  parts.push(`model ${info.model ?? "—"}`);
  if (info.view !== undefined && info.view !== "chat") {
    parts.push(`view ${info.view}`);
  }
  if (info.meshHint === true || (info.clusterTotal ?? 0) === 0) {
    parts.push("mesh · /mesh");
  } else if (info.clusterTotal !== undefined) {
    parts.push(`cluster ${info.clusterConnected ?? 0}/${info.clusterTotal}`);
  }
  parts.push(info.busy === true ? "busy" : "ready");
  return parts.join(" · ");
}

/** A minimal structural peer shape (keeps screen.ts client-agnostic). */
export interface RailPeer {
  id: string;
  model?: string;
  health: { ok: boolean; rttMs?: number };
}

/** Build the one-line cluster rail (always shown — hints when empty). */
export function buildRailLine(
  peers: readonly RailPeer[] | undefined,
  options?: { emptyHint?: string },
): string {
  const emptyHint =
    options?.emptyHint ??
    "no peers — /mesh for setup · envoy-peer serve + --peers id@host:port";
  if (peers === undefined || peers.length === 0) {
    return `mesh: ${emptyHint}`;
  }
  const rendered = peers.map((p) => {
    const model = p.model !== undefined ? `(${p.model})` : "";
    const health = p.health.ok
      ? p.health.rttMs !== undefined
        ? `rtt=${p.health.rttMs}ms`
        : "ok"
      : "down";
    return `${p.id}${model}[${health}]`;
  });
  return `peers: ${rendered.join("  ")}`;
}

/**
 * The screen renderer. Writes ANSI cursor/erase escapes to the output
 * stream; keeps the last rendered rows so unchanged lines are skipped.
 * No-ops when `enabled` is false (plain-mode callers handle output).
 */
export class Screen {
  readonly #output: NodeJS.WritableStream;
  readonly #width: number;
  readonly #height: number;
  readonly #accent: string | undefined;
  #last: string[] = [];
  #drawn = false;

  constructor(output: NodeJS.WritableStream, options: ScreenOptions = {}) {
    this.#output = output;
    this.#width = options.width ?? 80;
    this.#height = options.height ?? 24;
    this.#accent = options.accent;
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  /** Redraw with a diff. Rows are 1-based; the cursor ends on the input row. */
  render(model: ScreenLayoutModel): void {
    const rows = layoutRows(model, this.#width, this.#height);
    let out = "";
    if (!this.#drawn) {
      out += "\x1b[2J\x1b[H"; // clear once on first render
      this.#drawn = true;
    }
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] === this.#last[i]) continue;
      const rendered =
        i === 0 && this.#accent !== undefined
          ? `${this.#accent}${rows[0]}\x1b[0m`
          : rows[i];
      out += `\x1b[${i + 1};1H${rendered}\x1b[K`;
    }
    for (let i = rows.length; i < this.#last.length; i++) {
      out += `\x1b[${i + 1};1H\x1b[K`;
    }
    const inputLines = model.inputLines.length > 0 ? model.inputLines : [""];
    const cursorLine =
      model.inputCursorLine ?? Math.max(0, inputLines.length - 1);
    const activeLine = inputLines[Math.min(cursorLine, inputLines.length - 1)] ?? "";
    const cursorCol =
      Math.min(model.inputCursor ?? activeLine.length, this.#width - 1) + 1;
    const cursorRow = rows.length - inputLines.length + cursorLine + 1;
    out += `\x1b[${Math.min(cursorRow, rows.length)};${cursorCol}H`;
    this.#last = rows;
    this.#output.write(out);
  }

  /** Clear the screen and forget the diff state. */
  clear(): void {
    this.#output.write("\x1b[2J\x1b[H");
    this.#last = [];
    this.#drawn = false;
  }
}
