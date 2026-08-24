/**
 * Interactive run loop for the dedicated envoy-harness TUI.
 *
 * Two modes:
 * - **Screen mode** (TTY): ANSI regions — status bar, optional cluster
 *   rail, transcript window, composer input. Keymaps: Enter submit,
 *   Esc/Ctrl-C cancel, arrows history, Tab slash completion, Ctrl-U
 *   clear, Ctrl-D exit (empty input).
 * - **Plain mode** (pipes/CI): the legacy readline loop — transcript
 *   lines printed as they arrive, `> ` prompt, whole-line permissions.
 */

import * as readline from "node:readline";

import { Composer, type ComposerKey } from "./composer.js";
import {
  buildRailLine,
  buildStatusLine,
  buildViewTabLine,
  Screen,
} from "./screen.js";
import type { TuiSession } from "./session.js";
import { matchingSlashCommands, parseSlash } from "./slash.js";
import { formatTranscriptLine, type TranscriptFormatOptions } from "./transcript.js";
import { renderDiscoveryTicker } from "./views.js";
import {
  resolveClusterRoutePreviews,
  resolveViewBody,
  type ClusterRoutePreviews,
  type UiView,
} from "./view-resolver.js";

export interface RunInteractiveOptions {
  session: TuiSession;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Force screen mode (default: both streams are TTYs). */
  interactive?: boolean;
  /** Screen width (default 80). */
  width?: number;
  /** Screen height (default 24). */
  height?: number;
  /** Refresh the cluster rail before every render. Default true. */
  refreshCluster?: boolean;
  /** U5 — ANSI SGR prefix for the status bar (e.g. `"\x1b[36m"`). */
  accent?: string;
  /** U6a.2 — transcript + permission styling (default color on). */
  transcriptFormat?: TranscriptFormatOptions;
  /** Peer endpoints configured at launch (shown in `/mesh`). */
  configuredPeers?: ReadonlyArray<{ id: string; endpoint: string }>;
}

/** Run until `/quit`, Ctrl-D, or input ends. */
export async function runInteractive(
  options: RunInteractiveOptions,
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const { session } = options;

  await session.start();
  if (options.transcriptFormat !== undefined) {
    session.setTranscriptFormat(options.transcriptFormat);
  }

  const interactive =
    options.interactive ??
    (Boolean((input as NodeJS.ReadStream).isTTY) &&
      Boolean((output as NodeJS.WriteStream).isTTY));
  if (interactive) {
    return runInteractiveScreen({ ...options, input, output });
  }
  return runPlain({ ...options, input, output });
}

// ---------------------------------------------------------------------------
// Plain mode — legacy readline loop (non-TTY / pipes / CI).
// ---------------------------------------------------------------------------

async function runPlain(options: RunInteractiveOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const { session } = options;
  const transcriptFormat = options.transcriptFormat ?? { useColor: true };
  let printed = 0;
  const flush = (): void => {
    const lines = session.transcript;
    while (printed < lines.length) {
      const line = lines[printed];
      if (line !== undefined) {
        output.write(
          `${formatTranscriptLine(line, transcriptFormat)}\n`,
        );
      }
      printed++;
    }
  };

  session.setOnTranscript(() => flush());

  flush();

  const rl = readline.createInterface({
    input,
    output,
    terminal: Boolean((input as NodeJS.ReadStream).isTTY),
  });

  const prompt = (): void => {
    rl.setPrompt(session.busy ? "… " : "> ");
    rl.prompt();
  };

  prompt();

  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      void (async () => {
        if (session.pendingPermission !== undefined) {
          const d = line.trim().toLowerCase();
          if (d === "allow" || d === "a" || d === "y") {
            session.answerPermission("allow");
            flush();
            prompt();
            return;
          }
          if (d === "deny" || d === "d" || d === "n") {
            session.answerPermission("deny");
            flush();
            prompt();
            return;
          }
        }

        const result = await session.submit(line);
        flush();
        if (result === "quit") {
          rl.close();
          resolve();
          return;
        }
        prompt();
      })();
    });
    rl.on("close", () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Screen mode — ANSI regions + composer.
// ---------------------------------------------------------------------------

async function runInteractiveScreen(
  options: RunInteractiveOptions,
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const { session } = options;
  const screen = new Screen(output, {
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    ...(options.accent !== undefined ? { accent: options.accent } : {}),
  });
  const composer = new Composer();
  const refreshCluster = options.refreshCluster !== false;
  let modelLabel: string | undefined;
  let quitting = false;
  let view: UiView = "chat";
  let routeTag: string | undefined;
  let searchTerm: string | undefined;
  let discoveryUnsubscribe: (() => void) | undefined;
  let clusterRoutePreviews: ClusterRoutePreviews | undefined;
  let paletteIndex = 0;

  const inputPrefix = (): string => {
    if (session.pendingPermission !== undefined) {
      return "permission — allow/deny — ";
    }
    return session.busy ? "… " : "> ";
  };

  let renderChain: Promise<void> = Promise.resolve();
  const render = (): Promise<void> => {
    renderChain = renderChain.then(async () => {
      if (quitting) return;
      const cluster =
        refreshCluster || session.clusterSnapshot === undefined
          ? await session.refreshCluster()
          : session.clusterSnapshot;
      if (modelLabel === undefined) {
        modelLabel = await session.getModelLabel();
      }
      const clusterTotal = cluster?.peers.length ?? 0;
      const statusLine = buildStatusLine({
        ...(session.sessionId !== undefined
          ? { sessionId: session.sessionId }
          : {}),
        ...(modelLabel !== undefined ? { model: modelLabel } : {}),
        ...(view !== "chat" ? { view } : {}),
        meshHint: clusterTotal === 0,
        ...(clusterTotal > 0
          ? {
              clusterConnected: cluster?.connected ?? 0,
              clusterTotal,
            }
          : {}),
        busy: session.busy,
      });
      const tabLine = buildViewTabLine(view, {
        ...(options.accent !== undefined ? { accent: options.accent } : {}),
      });
      const railLine = buildRailLine(
        cluster?.peers.map((p) => ({
          id: p.id,
          ...(p.model !== undefined ? { model: p.model } : {}),
          health: {
            ok: p.health.ok,
            ...(p.health.rttMs !== undefined ? { rttMs: p.health.rttMs } : {}),
          },
        })),
      );
      if (view === "cluster") {
        clusterRoutePreviews = await resolveClusterRoutePreviews(
          session,
          cluster,
          clusterRoutePreviews,
        );
      }
      const viewBody = await resolveViewBody(
        view,
        routeTag,
        session,
        cluster,
        clusterRoutePreviews?.previews,
        searchTerm,
        options.configuredPeers !== undefined
          ? { configuredPeers: options.configuredPeers }
          : undefined,
        { color: true },
      );
      const ticker =
        session.discoveryEvents.length > 0
          ? renderDiscoveryTicker(session.discoveryEvents)
          : [];
      if (quitting) return; // a queued render may have started pre-quit
      const prefix = inputPrefix();
      const paletteItems = matchingSlashCommands(composer.buffer);
      if (paletteItems.length === 0) paletteIndex = 0;
      const bufferLines = composer.buffer.split("\n");
      const before = composer.buffer.slice(0, composer.cursor);
      const cursorLine = before.split("\n").length - 1;
      const lastNl = before.lastIndexOf("\n");
      screen.render({
        statusLine,
        railLine,
        tabLine,
        transcript: [...ticker, ...viewBody],
        inputLines: bufferLines.map((line, i) =>
          i === 0 ? `${prefix}${line}` : line,
        ),
        inputCursorLine: cursorLine,
        inputCursor: prefix.length + (composer.cursor - (lastNl + 1)),
        ...(session.imagesSupported &&
        composer.buffer.length === 0 &&
        view === "chat" &&
        !session.busy
          ? {
              composerHint:
                "images: paste ![alt](data:image/png;base64,…) in your message",
            }
          : {}),
        ...(paletteItems.length > 0
          ? {
              palette: paletteItems,
              paletteSelected: Math.min(paletteIndex, paletteItems.length - 1),
            }
          : {}),
      });
    });
    return renderChain;
  };

  const finish = (): void => {
    if (quitting) return;
    quitting = true;
    discoveryUnsubscribe?.();
    discoveryUnsubscribe = undefined;
    screen.clear();
    const raw = input as NodeJS.ReadStream;
    if (typeof raw.setRawMode === "function") raw.setRawMode(false);
    input.removeAllListeners("keypress");
    // Detach emitKeypressEvents' data consumer so an open stdin (TTY)
    // doesn't keep the process alive after the UI exits.
    input.removeAllListeners("data");
    if (typeof raw.pause === "function") raw.pause();
  };

  session.setOnTranscript(() => void render());

  await render();
  // U3 — subscribe to the host's discovery stream (best-effort).
  void session
    .subscribeDiscovery(() => void render())
    .then((unsub) => {
      discoveryUnsubscribe = unsub;
    })
    .catch(() => undefined);

  const raw = input as NodeJS.ReadStream;
  if (typeof raw.setRawMode === "function") raw.setRawMode(true);
  readline.emitKeypressEvents(input);

  await new Promise<void>((resolve) => {
    const handleSubmit = (rawLine: string): void => {
      void (async () => {
        const line = rawLine.trim();
        // U3 — detail-view commands switch the screen; Esc returns.
        const slash = parseSlash(line);
        if (slash !== null) {
          switch (slash.kind) {
            case "mesh":
              if (slash.action !== "connect") {
                view = "mesh";
                await render();
                return;
              }
              break;
            case "peers":
              view = "peers";
              await render();
              return;
            case "cluster":
              view = "cluster";
              await render();
              return;
            case "team":
              view = "team";
              await render();
              return;
            case "scoreboard":
              view = "scoreboard";
              await render();
              return;
            case "route":
              view = "route";
              routeTag = slash.tag;
              await render();
              return;
            case "search":
              view = "search";
              searchTerm = slash.term;
              await render();
              return;
            case "trace":
              view = "trace";
              await render();
              return;
            case "plan":
              if (slash.action === "show" || slash.action === "enter") {
                view = "plan";
                await render();
                return;
              }
              break;
            case "memory":
              if (slash.op === "list") {
                view = "memory";
                await render();
                return;
              }
              break;
            case "diff":
              session.setGitDiffFlags(slash.staged, slash.stat);
              view = "git-diff";
              await render();
              return;
            case "resume":
              if (slash.id === undefined || slash.id.length === 0) {
                view = "resume";
                await render();
                return;
              }
              break;
            default:
              break; // help/cancel/quit/unknown → session.submit
          }
        }
        if (view === "resume") {
          const pick = rawLine.trim();
          if (pick.length > 0) {
            const sessions = await session.listPersistedSessions();
            let id = pick;
            const n = Number(pick);
            if (Number.isInteger(n) && n >= 1 && n <= sessions.length) {
              id = sessions[n - 1]!.id;
            }
            await session.resumeSession(id);
            view = "chat";
          }
          await render();
          return;
        }
        if (view !== "chat") {
          // A plain message while in a detail view returns to chat.
          view = "chat";
        }
        if (session.pendingPermission !== undefined) {
          const d = line.toLowerCase();
          if (d === "allow" || d === "a" || d === "y") {
            session.answerPermission("allow");
          } else if (d === "deny" || d === "d" || d === "n") {
            session.answerPermission("deny");
          }
          await render();
          return;
        }
        const result = await session.submit(rawLine);
        if (result === "quit") {
          finish();
          resolve();
          return;
        }
        await render();
      })().catch((err: unknown) => {
        output.write(
          `\nerror: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        void render();
      });
    };

    input.on("keypress", (ch: string | undefined, key: ComposerKey) => {
      if (quitting) return;
      // U5+ — slash palette: while the composer holds a `/prefix`, arrows
      // navigate the palette, Enter selects, Esc closes, Tab completes.
      const paletteItems = matchingSlashCommands(composer.buffer);
      if (paletteItems.length > 0) {
        if (key.name === "up" || key.name === "down") {
          const delta = key.name === "up" ? -1 : 1;
          paletteIndex =
            (paletteIndex + delta + paletteItems.length) % paletteItems.length;
          void render();
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          const item =
            paletteItems[Math.min(paletteIndex, paletteItems.length - 1)];
          if (item !== undefined) {
            composer.setLine(item);
            const action = composer.handleKey(undefined, key);
            if (action.type === "submit") {
              // Reuse the submit path below.
              handleSubmit(action.line);
            }
          }
          return;
        }
        if (key.name === "escape") {
          composer.setLine("");
          paletteIndex = 0;
          void render();
          return;
        }
      }
      const action = composer.handleKey(ch, key);
      switch (action.type) {
        case "submit": {
          handleSubmit(action.line);
          break;
        }
        case "cancel": {
          if (view !== "chat") {
            view = "chat";
          } else if (session.pendingPermission !== undefined) {
            session.answerPermission("deny");
          } else if (session.busy) {
            void session.cancel();
          } else if (composer.buffer.length > 0) {
            composer.setLine("");
          }
          void render();
          break;
        }
        case "eof": {
          if (composer.buffer.length === 0) {
            finish();
            resolve();
            return;
          }
          composer.setLine("");
          void render();
          break;
        }
        case "change":
          void render();
          break;
      }
    });
    input.on("end", () => {
      finish();
      resolve();
    });
  });
}
