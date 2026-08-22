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

import type {
  ClientClusterStatus,
  ClientPeerInfo,
} from "@envoymesh/envoy-harness-client";

import { Composer, type ComposerKey } from "./composer.js";
import {
  buildRailLine,
  buildStatusLine,
  Screen,
} from "./screen.js";
import type { TuiSession } from "./session.js";
import { parseSlash } from "./slash.js";
import { formatTranscriptLine } from "./transcript.js";
import {
  renderClusterView,
  renderDiscoveryTicker,
  renderPeersView,
  renderRouteView,
  renderScoreboardView,
  renderSearchView,
  renderTeamView,
  renderTraceView,
} from "./views.js";

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
}

/** Run until `/quit`, Ctrl-D, or input ends. */
export async function runInteractive(
  options: RunInteractiveOptions,
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const { session } = options;

  await session.start();

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
  let printed = 0;
  const flush = (): void => {
    const lines = session.transcript;
    while (printed < lines.length) {
      const line = lines[printed];
      if (line !== undefined) {
        output.write(`${formatTranscriptLine(line)}\n`);
      }
      printed++;
    }
  };

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

/** Fetch a view body, falling back to an "unavailable" line on error. */
async function tryView(
  fn: () => Promise<string[]> | string[],
  label: string,
): Promise<string[]> {
  try {
    return await fn();
  } catch (err) {
    return [
      `${label} unavailable: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }
}

/** Resolve the screen's content area for the active view. */
async function resolveViewBody(
  view:
    | "chat"
    | "peers"
    | "cluster"
    | "team"
    | "scoreboard"
    | "route"
    | "search"
    | "trace",
  routeTag: string | undefined,
  session: TuiSession,
  cluster: ClientClusterStatus | undefined,
  clusterRoutePreviews?:
    | ReadonlyArray<{ tag: string; peer: ClientPeerInfo | undefined }>
    | undefined,
  searchTerm?: string,
): Promise<string[]> {
  if (view === "chat") {
    return session.transcript.map(formatTranscriptLine);
  }
  if (view === "peers") {
    return tryView(async () => renderPeersView(await session.peers()), "peers");
  }
  if (view === "cluster") {
    return renderClusterView(
      cluster ?? { peers: [], connected: 0, failed: 0 },
      clusterRoutePreviews,
    );
  }
  if (view === "team") {
    return tryView(
      async () => renderTeamView(await session.teamJobs()),
      "team",
    );
  }
  if (view === "scoreboard") {
    return tryView(
      async () => renderScoreboardView(await session.scoreboard()),
      "scoreboard",
    );
  }
  if (view === "search") {
    return searchTerm !== undefined
      ? renderSearchView(
          session.transcript.map(formatTranscriptLine),
          searchTerm,
        )
      : ["/search <term> — search the transcript"];
  }
  if (view === "trace") {
    return renderTraceView(session.discoveryEvents);
  }
  return routeTag !== undefined
    ? tryView(
        async () =>
          renderRouteView({
            tag: routeTag,
            peer: await session.route(routeTag),
          }),
        "route",
      )
    : ["/route <tag> — preview routing"];
}

/**
 * U3 follow-up — routing previews for the cluster view: derive candidate
 * tags from the peers' capabilities and ask the host which peer would
 * run each. Cached (10s TTL) so typing in the view doesn't re-route
 * every keystroke.
 */
async function resolveClusterRoutePreviews(
  session: TuiSession,
  cluster: ClientClusterStatus | undefined,
  cached:
    | {
        at: number;
        previews: Array<{ tag: string; peer: ClientPeerInfo | undefined }>;
      }
    | undefined,
): Promise<{
  at: number;
  previews: Array<{ tag: string; peer: ClientPeerInfo | undefined }>;
}> {
  const now = Date.now();
  if (cached !== undefined && now - cached.at < 10_000) return cached;
  const tags = [
    ...new Set(
      (cluster?.peers ?? [])
        .filter((p) => p.health.ok)
        .flatMap((p) => p.capabilities ?? []),
    ),
  ].slice(0, 5);
  const previews =
    tags.length === 0
      ? []
      : await Promise.all(
          tags.map(async (tag) => ({
            tag,
            peer: await session.route(tag),
          })),
        );
  return { at: now, previews };
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
  let view:
    | "chat"
    | "peers"
    | "cluster"
    | "team"
    | "scoreboard"
    | "route"
    | "search"
    | "trace" = "chat";
  let routeTag: string | undefined;
  let searchTerm: string | undefined;
  let discoveryUnsubscribe: (() => void) | undefined;
  let clusterRoutePreviews:
    | {
        at: number;
        previews: Array<{ tag: string; peer: ClientPeerInfo | undefined }>;
      }
    | undefined;

  const inputPrefix = (): string => {
    if (session.pendingPermission !== undefined) {
      return "permission: type allow or deny — ";
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
        ...(clusterTotal > 0
          ? {
              clusterConnected: cluster?.connected ?? 0,
              clusterTotal,
            }
          : {}),
        busy: session.busy,
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
      );
      const ticker =
        session.discoveryEvents.length > 0
          ? renderDiscoveryTicker(session.discoveryEvents)
          : [];
      const prefix = inputPrefix();
      screen.render({
        statusLine,
        ...(railLine !== undefined ? { railLine } : {}),
        transcript: [...ticker, ...viewBody],
        inputLine: `${prefix}${composer.buffer}`,
        inputCursor: prefix.length + composer.cursor,
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
  };

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
    input.on("keypress", (ch: string | undefined, key: ComposerKey) => {
      if (quitting) return;
      const action = composer.handleKey(ch, key);
      switch (action.type) {
        case "submit": {
          void (async () => {
            const line = action.line.trim();
            // U3 — detail-view commands switch the screen; Esc returns.
            const slash = parseSlash(line);
            if (slash !== null) {
              switch (slash.kind) {
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
                default:
                  break; // help/cancel/quit/unknown → session.submit
              }
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
            const result = await session.submit(action.line);
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
