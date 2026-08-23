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
  const inputLines = model.inputLines.length > 0 ? model.inputLines : [""];
  const palette = model.palette ?? [];
  const bottom = palette.length + inputLines.length;
  const usedTop = rows.length; // 1 (status) or 2 (status + rail)
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
}

/** Build the one-line status bar (pure). */
export function buildStatusLine(info: StatusBarInfo): string {
  const parts = ["envoy-harness"];
  if (info.sessionId !== undefined) parts.push(`session ${info.sessionId}`);
  parts.push(`model ${info.model ?? "—"}`);
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
